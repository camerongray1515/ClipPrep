# AGENTS.md

Working notes for anyone (human or AI) changing ClipPrep. The README covers what the app does. This file covers how it's built, and why the less obvious decisions were made. Most of those decisions came from testing against real footage, so read the relevant section before "simplifying" something.

## Overview

ClipPrep is a macOS-only Electron app. It analyses video clips before they are imported into Final Cut Pro. It finds cue tones that mark mistakes, transcribes the speech, works out which failed takes to remove, and exports FCPXML with those ranges marked as keywords or rejected ranges. macOS only is deliberate, because the output is only useful in Final Cut Pro; don't add Windows or Linux code paths.

- Plain CommonJS JavaScript. No framework, bundler or TypeScript. The renderer is a single vanilla-JS file.
- Runtime dependencies: `ffmpeg-static` and `ffprobe-static`. External: `whisper-cli` from whisper.cpp (Homebrew, or bundled in `Contents/Resources/whisper/`).
- Data folder: `~/Library/Application Support/ClipPrep`, which holds `settings.json`, `models/`, `cache/` and `proxies/`.

## Layout

```
src/core/        Pure Node pipeline, usable without Electron (the CLI and tests use it directly)
  media.js           ffprobe/ffmpeg: probe, decode audio to 16 kHz mono float32, WAV encode, preview proxy
  audio-analysis.js  10 ms frames: RMS envelope + Goertzel tone ratio; tone detection; noise floor; sound regions
  transcribe.js      whisper-cli runner; tokens → words; model list; whisper discovery
  retakes.js         Retake matching and cut placement (pure, unit tested). The core logic.
  analyzer.js        Orchestrates a clip: probe → decode/frames (cached) → tones → transcribe (cached)
  fcpxml.js          FCPXML 1.11 export, timecode rules
  sony.js            Sony NonRealTimeMeta sidecar (CLIPNAMEM01.XML): status flag + LTC timecode
  settings.js        Defaults and deep merge with saved settings
src/main/        Electron main process (IPC, dialogs, model downloads) and preload bridge
src/renderer/    index.html, app.js, styles.css
scripts/         analyze-cli.js (headless report + export), smoke.js (UI test with screenshots)
test/            node:test unit tests
docs/BUILDING.md Packaging with electron-builder, including a bundleable whisper-cli
```

The renderer talks only through `window.api` (preload, contextIsolation on). The main process keeps the analysis state per file. Cut computation (`computeCuts`) is cheap and re-runs on every settings change or tone override. Only tone, audio-track and model settings trigger re-analysis.

## Commands

```bash
npm start                                     # run the app
npm test                                      # unit tests (retakes, fcpxml, sony)
npm run analyze -- [--fcpxml out.fcpxml] f…   # headless pipeline; prints tones, matched text and cuts
npx electron scripts/smoke.js <outDir> f…     # drives the real UI, prints checks, saves PNGs
npm run dist                                  # build .dmg/.zip (see docs/BUILDING.md)
```

`analyze-cli` is the quickest way to check how a pipeline change affects detection. Run it over a set of clips before and after the change and `diff` the outputs.

To validate an export, run it against Final Cut's own DTD. Copy the DTD first, because xmllint fails on the space in its path:

```bash
cp "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_11.dtd" /tmp/fcpxml.dtd
xmllint --noout --dtdvalid /tmp/fcpxml.dtd out.fcpxml
```

## Pipeline decisions and the reasons behind them

### Audio and tone detection
- All audio tracks are mixed (`amix normalize=0`) by default. Cameras differ in which track carries the tone (OBS recordings: track 1 only; Sony: all four).
- Tone detection uses a Goertzel filter on 20 ms windows with a 10 ms hop. The ratio is normalised against frame energy, so 1.0 means a pure tone. Defaults: ratio ≥ 0.5, ≥ 0.5 s long.
- **Noise floor**: the 10th percentile of *non-silent* frames (RMS > 3e-5). Some recorders insert digital silence around the tone. Including those frames drags the floor to zero, and room noise then counts as speech.

### Transcription (whisper.cpp)
- **Each stretch between tones is transcribed as its own file.** Run as one pass, whisper merges the failed take and the retake into one sentence and drops the repeated words, which destroys the evidence the matcher needs.
- **Don't split those chunks further at silences.** Tried: whisper then hallucinates "Thanks for watching!" on the short noise fragments left behind.
- Chunks are trimmed of leading silence, because whisper skips speech after a long silent lead-in. Up to 2 s of trailing silence is kept, because without it whisper drops the final unfinished phrase, which is exactly the failed take.
- Word timings come from DTW (`-dtw <preset>`), which requires `-nfa` (flash attention off). The preset name is derived from the model file name (`ggml-small.en.bin` → `small.en`).
- **Don't use whisper's `--vad`.** Tried: it corrupts the DTW timestamps, moving cut points by 5–15 s.
- DTW onsets are reliable but word ends aren't, so a word's end is set to the next word's start. The first word of a chunk is often placed early, in the preceding silence. `retakes.js` corrects this by searching forward for the real onset, up to the next word.
- **Hallucination filter** (`dropHallucinations`): drop any whisper *segment* whose words are all aligned to one instant (span < 0.05 s per word). This catches "Thanks for watching!" and looped phrases. Filtering on word density instead was too aggressive, because DTW also packs genuine fast speech tightly ("we're going to" within 0.08 s).
- Raw words are cached and filtered on read, so the filter can be tuned without re-transcribing.

### Retake matching (`retakes.js`)
- For each tone: B = the first `compareWords` words after the tone. Candidate A = the words starting at each position before the tone, back to the previous tone or the lookback limit. The score is a fuzzy LCS of A and B (word similarity = normalised Levenshtein), divided by `min(|A|, |B|)`.
- A[0] must match one of B's first `anchorSlack + 1` words, so a cut never starts mid-phrase.
- The highest score wins. Ties go to the earliest position, so repeated false starts are all removed.
- If the chunk before a tone contains no words at all (whisper missed it), the search continues past earlier tones.
- Fallback when nothing matches: cut back to the start of the interrupted sentence, where a word ending in `.?!` or a pause ≥ `fallbackPause` counts as a boundary. These cuts are marked `uncertain` ("Maybe Cut").
- Cut points snap to sound onsets using the envelope. Walking back up to 0.5 s over continuous sound is allowed only if it lands on silence, which catches a short first word whisper missed. Otherwise the walk-back is limited to 0.15 s so the end of the previous good word isn't clipped.
- Overlapping cuts are merged. A merged cut is `uncertain` if any part of it is.

### FCPXML export (`fcpxml.js`)
- **The clip start time in the XML must match what Final Cut reads from the media.** Otherwise every keyword range falls outside the clip and **Final Cut drops it silently**, with no error or warning. This happened twice. Sony clips were exported at their camera timecode (~11:00:00) while Final Cut treated them as starting at 0: first without the M01.XML sidecars, then with them (NX800 card clips imported straight from `M4ROOT/CLIP`).
- Timecode rule (`fcpReadsTimecode`, setting `export.timecode = 'auto'`): use the timecode only when it comes from a QuickTime `tmcd` track. When importing FCPXML that references the MP4 directly, Final Cut ignores Sony XAVC timecode (the MP4's `rtmd` track *and* the M01.XML sidecar), so Sony clips start at 0. Final Cut does use the sidecar timecode when clips come in through its own card-import window, which is why a Final Cut export of card-imported clips shows camera timecode. Don't take that as evidence for FCPXML imports.
- Sony sidecar timecode is drop-frame on 29.97 material, flagged by bit 0x40 of the frames byte in the LTC value; ffprobe's tag for the same clip shows `:` and loses that. It's used only with `export.timecode = 'source'`. It matches what Final Cut shows for card-imported clips: GARAGE7452 at `06:12:26;10` DF → `start="670389720/30000s"`.
- Time values are rationals: integer rates use `100/(N*100)s`, NTSC rates use `1001/(N*1000)s`. Cut ranges are rounded *inwards* to whole frames.
- Format names follow Final Cut's own: `FFVideoFormat3840x2160p2997` (not `…2160p2997`), `FFVideoFormat1080p2997`.
- Element order inside `asset-clip` follows the DTD. Keywords, ratings and markers are all `%marker_item;` and may be interleaved. `keyword-collection` elements go in the event.
- Clips flagged `NG` in their Sony sidecar get a `rating value="reject"` spanning the whole clip.

### Playback
- Chromium in Electron decodes Sony XAVC 4:2:2 10-bit H.264 with PCM audio, and OBS H.264. The proxy path (`makeProxy`, `h264_videotoolbox`, then `libx264` as fallback) is only a safety net.
- The renderer tracks which file the `<video>` holds (`video.dataset.file`). Selecting a clip before its analysis finished used to leave the player empty.

## Caching
`analyzer.js` caches decoded-audio frames and raw transcripts as JSON in the data folder's `cache/`. The keys hash file identity (path, size, mtime) plus the relevant settings. **Bump `CACHE_VERSION` whenever the decode, chunking or transcription output changes**, or stale results will be reused.

## Conventions
- Keep `src/core` free of Electron imports. Paths and settings are passed in, so the CLI and tests can use it.
- Comments explain *why*, especially where a decision came from testing on footage. Keep those comments when refactoring.
- Every behaviour change to matching or export should come with a unit test (`test/`). Use `analyze-cli` diffs over real clips for anything heuristic.
- `ffprobe-static` is ffprobe 4.4. It's adequate for probing, but don't rely on it for newer codec names. Decoding uses `ffmpeg-static` (6.0).
