// Frame-level audio analysis: loudness envelope and cue-tone detection.
const { ANALYSIS_RATE } = require('./media');

const HOP = 0.01; // seconds per analysis frame
const HOP_SAMPLES = Math.round(HOP * ANALYSIS_RATE);
const TONE_WINDOW = 2 * HOP_SAMPLES; // 20 ms window → 50 Hz bin width

// Returns per-frame RMS (linear) and the fraction of each frame's energy at `freq`.
function analyzeFrames(samples, freq) {
  const frames = Math.floor(samples.length / HOP_SAMPLES);
  const rms = new Float32Array(frames);
  const tone = new Float32Array(frames);
  const w = (2 * Math.PI * freq) / ANALYSIS_RATE;
  const coeff = 2 * Math.cos(w);

  for (let f = 0; f < frames; f++) {
    const start = f * HOP_SAMPLES;
    let e = 0;
    for (let i = start; i < start + HOP_SAMPLES; i++) e += samples[i] * samples[i];
    rms[f] = Math.sqrt(e / HOP_SAMPLES);

    const end = Math.min(samples.length, start + TONE_WINDOW);
    const n = end - start;
    let s1 = 0, s2 = 0, energy = 0;
    for (let i = start; i < end; i++) {
      const x = samples[i];
      const s = x + coeff * s1 - s2;
      s2 = s1;
      s1 = s;
      energy += x * x;
    }
    // Goertzel power normalised against total window energy (Parseval): 1.0 = pure tone.
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    tone[f] = energy > 1e-9 ? Math.min(1, (2 * power) / (n * energy)) : 0;
  }
  return { hop: HOP, rms, tone };
}

// Noise floor as a low percentile of frame loudness, so thresholds adapt to each recording.
// Digital silence (some recorders mute around the cue tone) is excluded or it drags the floor to zero.
function noiseFloor(rms) {
  const live = Float32Array.from(rms.filter((v) => v > 3e-5)).sort();
  return live.length ? Math.max(3e-5, live[Math.floor(live.length * 0.1)]) : 3e-5;
}

// Find sustained tone regions. Settings: { threshold, minDuration, mergeGap }.
function detectTones(frames, settings) {
  const { hop, rms, tone } = frames;
  const floor = noiseFloor(rms);
  const regions = [];
  let cur = null;
  for (let f = 0; f < tone.length; f++) {
    const on = tone[f] >= settings.threshold && rms[f] > floor * 2;
    if (on) {
      if (cur && f - cur.endFrame <= settings.mergeGap / hop) cur.endFrame = f + 1;
      else {
        if (cur) regions.push(cur);
        cur = { startFrame: f, endFrame: f + 1 };
      }
    }
  }
  if (cur) regions.push(cur);

  return regions
    .map((r) => ({ start: r.startFrame * hop, end: r.endFrame * hop }))
    .filter((r) => r.end - r.start >= settings.minDuration);
}

/**
 * Split [t0, t1) into regions containing sound, separated by silences of at least `minSilence`
 * seconds. Whisper hallucinates in long silences and mis-times the words after them, so each
 * region is transcribed on its own.
 */
function soundRegions(frames, t0, t1, { thresholdDb, minSilence = 1.5, minSound = 0.3, pad = 0.25 }) {
  const { hop, rms } = frames;
  const thr = noiseFloor(rms) * Math.pow(10, thresholdDb / 20);
  const f0 = Math.max(0, Math.floor(t0 / hop));
  const f1 = Math.min(rms.length, Math.ceil(t1 / hop));
  const regions = [];
  let cur = null;
  let quiet = 0;
  for (let f = f0; f < f1; f++) {
    if (rms[f] > thr) {
      if (!cur) cur = { start: f, end: f + 1, sound: 0 };
      cur.end = f + 1;
      cur.sound++;
      quiet = 0;
    } else if (cur && ++quiet * hop >= minSilence) {
      regions.push(cur);
      cur = null;
    }
  }
  if (cur) regions.push(cur);
  return regions
    .filter((r) => r.sound * hop >= minSound)
    .map((r) => ({ start: Math.max(t0, r.start * hop - pad), end: Math.min(t1, r.end * hop + pad) }));
}

module.exports = { analyzeFrames, detectTones, noiseFloor, soundRegions, HOP };
