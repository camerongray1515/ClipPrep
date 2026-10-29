// Transcription via whisper.cpp (whisper-cli) with DTW token alignment for word timings.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { encodeWav, ANALYSIS_RATE } = require('./media');

// Homebrew locations aren't on PATH for apps launched from Finder.
const WHISPER_CANDIDATES = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'];
const WHISPER_INSTALL_HINT = 'brew install whisper-cpp';

const MODELS = [
  { file: 'ggml-base.en.bin', label: 'Base (English) — 148 MB, fastest' },
  { file: 'ggml-small.en.bin', label: 'Small (English) — 488 MB, recommended' },
  { file: 'ggml-medium.en.bin', label: 'Medium (English) — 1.5 GB' },
  { file: 'ggml-large-v3-turbo.bin', label: 'Large v3 Turbo (multilingual) — 1.6 GB' },
];
const MODEL_URL = (f) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${f}`;

// Search order: the path set in Settings, a copy bundled with a packaged build
// (resources/whisper/), Homebrew, then PATH.
function findWhisper(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'whisper', 'whisper-cli'));
  candidates.push(...WHISPER_CANDIDATES);
  for (const dir of (process.env.PATH || '').split(':')) if (dir) candidates.push(path.join(dir, 'whisper-cli'));
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// whisper.cpp DTW alignment-head presets are named after the model, e.g. ggml-large-v3-turbo.bin → large.v3.turbo
function dtwPreset(modelFile) {
  const m = /ggml-(.+?)(?:-q\d.*)?\.bin$/.exec(path.basename(modelFile));
  return m ? m[1].replace(/-/g, '.') : null;
}

const NON_SPEECH = /^\s*[\[(].*[\])]\s*$/; // [BLANK_AUDIO], (music) etc.

// Join whisper's sub-word tokens into words. Tokens beginning with a space start a new word.
function tokensToWords(segments, offset, chunkEnd, chunkIndex = 0) {
  const words = [];
  for (const [segIndex, seg] of segments.entries()) {
    for (const tok of seg.tokens || []) {
      const text = tok.text;
      if (!text || text.startsWith('[_') || NON_SPEECH.test(text)) continue;
      const dtw = typeof tok.t_dtw === 'number' && tok.t_dtw >= 0 ? tok.t_dtw / 100 : null;
      const t = offset + (dtw ?? tok.offsets.from / 1000);
      const startsWord = /^\s/.test(text) || words.length === 0;
      const isPunct = /^[^\w']+$/.test(text.trim());
      if (startsWord && !isPunct) {
        words.push({ text: text.trim(), start: t, end: t, p: tok.p, seg: `${chunkIndex}:${segIndex}` });
      } else if (words.length) {
        const w = words[words.length - 1];
        w.text += text.trim();
        if (!isPunct) w.end = t;
        w.p = Math.min(w.p, tok.p);
      }
    }
  }
  // A word ends where the next begins (DTW gives onsets reliably, not offsets); cap long tails.
  for (let i = 0; i < words.length; i++) {
    const next = i + 1 < words.length ? words[i + 1].start : chunkEnd;
    words[i].end = Math.min(next, Math.max(words[i].end, words[i].start) + 1.0);
  }
  return words;
}

/**
 * Transcribe a list of time ranges of `samples` independently, so whisper never sees across a cue
 * tone (it otherwise merges a failed take and its retake into one sentence).
 * Returns words with absolute times.
 */
async function transcribeChunks(samples, chunks, { whisperPath, modelPath, workDir, language, onProgress }) {
  const bin = findWhisper(whisperPath);
  if (!bin) throw new Error(`whisper-cli not found. Install it with \`${WHISPER_INSTALL_HINT}\` or set its path in Settings.`);
  if (!fs.existsSync(modelPath)) throw new Error(`Whisper model not found: ${path.basename(modelPath)}. Download it in Settings.`);
  if (!chunks.length) return [];

  fs.mkdirSync(workDir, { recursive: true });
  const files = chunks.map((c, i) => {
    const f = path.join(workDir, `chunk-${String(i).padStart(4, '0')}.wav`);
    const a = Math.floor(c.start * ANALYSIS_RATE), b = Math.ceil(c.end * ANALYSIS_RATE);
    fs.writeFileSync(f, encodeWav(samples.subarray(a, b)));
    return f;
  });

  const args = ['-m', modelPath, '-ojf', '-np', '-pp', '-sns', '-l', language || 'en'];
  const preset = dtwPreset(modelPath);
  if (preset) args.push('-nfa', '-dtw', preset); // DTW is incompatible with flash attention
  // Note: whisper.cpp's --vad option is deliberately not used; it corrupts DTW word timings.
  for (const f of files) args.push('-f', f);

  const totalDur = chunks.reduce((s, c) => s + (c.end - c.start), 0);
  await new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = '', fileIdx = 0, doneDur = 0;
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err = (err + s).slice(-4000);
      for (const m of s.matchAll(/progress =\s+(\d+)%/g)) {
        const pct = Number(m[1]) / 100;
        const dur = chunks[fileIdx] ? chunks[fileIdx].end - chunks[fileIdx].start : 0;
        onProgress?.(Math.min(1, (doneDur + pct * dur) / totalDur));
        if (pct >= 1) { doneDur += dur; fileIdx++; }
      }
    });
    p.stdout.on('data', () => {});
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper-cli failed (${code}): ${err}`))));
  });

  const words = [];
  files.forEach((f, i) => {
    const json = JSON.parse(fs.readFileSync(`${f}.json`, 'utf8'));
    words.push(...tokensToWords(json.transcription || [], chunks[i].start, chunks[i].end, i));
  });
  fs.rmSync(workDir, { recursive: true, force: true });
  return words;
}

module.exports = { transcribeChunks, findWhisper, WHISPER_INSTALL_HINT, dtwPreset, tokensToWords, MODELS, MODEL_URL };
