// Runs the full per-clip pipeline with on-disk caching of the slow stages (decode, transcription),
// so tweaking matching settings re-computes cuts instantly.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { probe, decodeAudio, ANALYSIS_RATE } = require('./media');
const { analyzeFrames, detectTones, soundRegions } = require('./audio-analysis');
const { transcribeChunks } = require('./transcribe');
const { analyzeCuts } = require('./retakes');

const CACHE_VERSION = 7;

const hash = (obj) => crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 16);

function fileIdentity(file) {
  const st = fs.statSync(file);
  return { file, size: st.size, mtime: st.mtimeMs };
}

function readCache(cacheDir, key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir, `${key}.json`), 'utf8'));
  } catch {
    return null;
  }
}
function writeCache(cacheDir, key, value) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `${key}.json`), JSON.stringify(value));
}

const f32ToB64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const b64ToF32 = (s) => {
  const b = Buffer.from(s, 'base64');
  const out = new Float32Array(b.length >> 2);
  Buffer.from(out.buffer).set(b.subarray(0, out.length * 4));
  return out;
};

// Chunks for transcription: the stretches between tones that contain any sound. Each is
// transcribed on its own so whisper never hears across a tone. (Splitting further at silences
// was tried: whisper then hallucinates "Thanks for watching!" on the short noise fragments.)
function speechChunks(tones, duration, frames, thresholdDb) {
  const chunks = [];
  let t = 0;
  for (const tone of [...tones, { start: duration, end: duration }]) {
    const sound = tone.start - t > 0.3 ? soundRegions(frames, t, tone.start, { thresholdDb, pad: 0.5 }) : [];
    // Trim leading silence (whisper tends to skip speech after a long silent lead-in) but keep some
    // trailing silence (without it whisper tends to drop a final unfinished phrase — the failed take).
    if (sound.length) chunks.push({ start: sound[0].start, end: Math.min(tone.start, sound[sound.length - 1].end + 2) });
    t = tone.end;
  }
  return chunks;
}

// Whisper hallucinations in silence or noise ("Thanks for watching!", or one phrase looped) come
// out as whole segments whose words are all aligned to the same instant. Real speech can't fit
// several words into a few hundredths of a second, so drop any segment like that.
function dropHallucinations(words) {
  const segs = new Map();
  for (const w of words) {
    if (!segs.has(w.seg)) segs.set(w.seg, []);
    segs.get(w.seg).push(w);
  }
  const bad = new Set();
  for (const [seg, ws] of segs) {
    if (seg === undefined || ws.length < 2) continue;
    if (ws[ws.length - 1].start - ws[0].start < 0.05 * ws.length) ws.forEach((w) => bad.add(w));
  }
  return words.filter((w) => !bad.has(w));
}

/**
 * settings: { audioTrack, tone: {...}, transcription: { whisperPath, modelPath, language }, matching, cuts }
 * onProgress(stage, fraction)
 */
async function analyzeClip(file, settings, { cacheDir, onProgress = () => {} }) {
  const id = fileIdentity(file);
  onProgress('probe', 0);
  const info = await probe(file);

  // Stage 1: decode audio + frame analysis (cached).
  const audioKey = hash({ v: CACHE_VERSION, id, track: settings.audioTrack, freq: settings.tone.frequency });
  let audio = readCache(cacheDir, `audio-${audioKey}`);
  let samples = null;
  let frames;
  if (audio) {
    frames = { hop: audio.hop, rms: b64ToF32(audio.rms), tone: b64ToF32(audio.tone) };
  } else {
    onProgress('decode', 0);
    samples = await decodeAudio(file, info, settings.audioTrack, (p) => onProgress('decode', p));
    frames = analyzeFrames(samples, settings.tone.frequency);
    writeCache(cacheDir, `audio-${audioKey}`, { hop: frames.hop, rms: f32ToB64(frames.rms), tone: f32ToB64(frames.tone) });
  }

  // Stage 2: tone detection (cheap).
  const tones = detectTones(frames, settings.tone);

  // Stage 3: transcription of each chunk between tones (cached).
  const tr = settings.transcription;
  const chunks = speechChunks(tones, info.duration, frames, settings.cuts.silenceDb);
  const trKey = hash({ v: CACHE_VERSION, audioKey, model: path.basename(tr.modelPath), lang: tr.language, chunks });
  let transcript = readCache(cacheDir, `words-${trKey}`);
  if (!transcript) {
    if (!samples) {
      onProgress('decode', 0);
      samples = await decodeAudio(file, info, settings.audioTrack, (p) => onProgress('decode', p));
    }
    onProgress('transcribe', 0);
    const words = await transcribeChunks(samples, chunks, {
      whisperPath: tr.whisperPath,
      modelPath: tr.modelPath,
      language: tr.language,
      workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clipprep-')),
      onProgress: (p) => onProgress('transcribe', p),
    });
    transcript = { words };
    writeCache(cacheDir, `words-${trKey}`, transcript);
  }
  onProgress('done', 1);

  return { info, frames, tones, words: dropHallucinations(transcript.words), rawWordCount: transcript.words.length };
}

// Cheap re-computation of cuts from cached analysis, used whenever settings or overrides change.
function computeCuts(analysis, settings, overrides) {
  return analyzeCuts(
    { words: analysis.words, tones: analysis.tones, frames: analysis.frames, duration: analysis.info.duration },
    settings.matching,
    settings.cuts,
    overrides,
  );
}

module.exports = { analyzeClip, computeCuts, speechChunks, dropHallucinations };
