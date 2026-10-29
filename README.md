<p align="center"><img src="build/icon.png" alt="ClipPrep icon" width="128"></p>

# ClipPrep

[![AI-DECLARATION: copilot](https://img.shields.io/badge/䷼%20AI--DECLARATION-copilot-fee2e2?labelColor=fee2e2)](AI-DECLARATION.md)

ClipPrep is a macOS app that prepares camera footage for Final Cut Pro before it is imported. It finds mistakes marked during recording and works out which parts of each clip should be removed. It then exports an FCPXML file that imports the clips with those sections already tagged.

## Disclaimer
This project was built for my own personal use to speed up editing my own videos based on my own workflow.  The project was predominanty AI built and has only been tested through my own use. I'm sharing the project in case it may be of use to anyone but it is in no way a complete, production ready application and I have no long term plans to support this beyond fixes/improvements based on my own use of the software.

## The recording workflow it supports

When a take goes wrong during recording, the presenter plays a short cue tone (1 kHz by default) and starts the sentence again. In my use, I generate the tone using the "Color Bars" feature on my Sony HXR-NX800 camera which is assigned to a shortcut button to make it easy to trigger..

A typical recording looks like this:

> The quick brown dog *[tone]* The quick brown fox ate *[tone]* The quick brown fox jumped over the lazy dog.

ClipPrep finds each tone and transcribes the speech around it. It then looks for the phrase the retake opens with in the speech before the tone, which is where the failed take started. In the example above it marks *"The quick brown dog [tone] The quick brown fox ate [tone]"* for removal and keeps the final take. Matching is fuzzy, so small wording or transcription differences still match. How strict it is can be configured.

## Features

- **Cue-tone detection** across all audio tracks, with configurable frequency, purity and minimum length.
- **Local transcription** with [whisper.cpp](https://github.com/ggml-org/whisper.cpp), using word-level timings.
- **Retake matching.** Fuzzy phrase matching finds where each failed take began, including several failed takes in a row. If the retake doesn't repeat the opening words, the cut falls back to the interrupted sentence and is flagged for review.
- **Review UI.** The UI has a video preview, a waveform timeline with the cuts overlaid, and a card for each tone showing what will be cut and kept. The transcript shows cut words struck through, and a "skip cuts" playback mode lets the editor hear the result. Each tone can be overridden: Auto, Sentence, Tone only or Off.
- **FCPXML export.** Clips are exported as an event of browser clips. Cuts become keyword ranges ("Retake Cut" / "Maybe Cut") and/or rejected ranges, with optional markers at each tone. The media is referenced in place and never modified.
- **Sony camera metadata.** ClipPrep reads the `M01.XML` sidecar files written by Sony XDCAM/XAVC cameras (e.g. the HXR-NX800). It shows each clip's status flag (KEEP, NG, …) when the clip is added and rejects NG clips in their entirety on export.

## Requirements

- Node.js 20 or later (for running from source)
- macOS on Apple Silicon or Intel
- whisper.cpp's `whisper-cli`: `brew install whisper-cpp` (standalone builds can bundle it instead; see [docs/BUILDING.md](docs/BUILDING.md))
- A Whisper model, downloaded from within the app on first run (*Small (English)*, 488 MB, is the default)

ffmpeg and ffprobe are bundled through npm.

## Running from source

```bash
npm install
npm start
```

Add clips with **Add Clips…** or by dropping them onto the window. Each clip is analysed in turn. Review the cuts, then use **Export FCPXML…**. With **Open in Final Cut** ticked, the file is opened in Final Cut Pro straight away; otherwise import it with **File → Import → XML**.

To build a standalone `.app` / `.dmg`, see [docs/BUILDING.md](docs/BUILDING.md).

## How it works

1. **Cue tones.** Audio from every track is mixed and decoded to 16 kHz mono, then scanned in 10 ms frames for sustained energy at the tone frequency (Goertzel filter).
2. **Transcription.** Each stretch between tones is transcribed separately, using whisper.cpp's DTW alignment for word timings. Whisper would otherwise merge a failed take and its retake into one sentence. Hallucinated segments, whose words all collapse onto one instant, are discarded.
3. **Retake matching.** For each tone, the first *N* words after it (the retake) are compared against the words before it to find where the same phrase was started. The range from there, through the tone, to the start of the retake is cut.
4. **Snapping.** Cut points are moved to the actual sound onsets using the loudness envelope, leaving a little air either side.
5. **Export.** FCPXML 1.11, with frame-accurate ranges in each clip's own timebase.

Changes to matching, cut placement and export settings apply instantly. Changing tone, audio-track or model settings re-runs analysis. Settings, Whisper models, the analysis cache and preview proxies are stored in `~/Library/Application Support/ClipPrep`.

## Importing camera footage with sidecars

Sony cameras write `CLIPNAMEM01.XML` next to each clip (`M4ROOT/CLIP/` on the card). ClipPrep reads the clip's status flag from it, so keep the XML files beside the clips (import straight from the card, or copy the whole `CLIP` folder).

The exported ranges must use the same clip start time that Final Cut uses, or Final Cut silently drops them. When importing FCPXML, Final Cut ignores the camera timecode of Sony XAVC MP4s, with or without the XML files, and starts them at 0, so ClipPrep does the same. Clips with a standard QuickTime timecode track keep their timecode. The **Clip start timecode** setting can override this.

## Development

```bash
npm test                                             # unit tests
npm run analyze -- clip.mp4 …                        # headless analysis report
npm run analyze -- --fcpxml out.fcpxml clip.mp4 …    # …and FCPXML export
npx electron scripts/smoke.js <outDir> clip.mp4 …    # UI smoke test that saves screenshots
```

See [AGENTS.md](AGENTS.md) for architecture notes and the reasoning behind non-obvious design decisions.
