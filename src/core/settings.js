const { DEFAULT_MATCHING, DEFAULT_CUTS } = require('./retakes');

const DEFAULT_SETTINGS = {
  audioTrack: 'mix', // 'mix' or a 0-based audio track index
  tone: {
    frequency: 1000, // Hz
    threshold: 0.5, // fraction of frame energy at the tone frequency
    minDuration: 0.5, // seconds
    mergeGap: 0.25, // seconds; joins tone fragments split by dropouts
  },
  transcription: {
    whisperPath: '', // blank = auto-detect (Homebrew / PATH)
    model: 'ggml-small.en.bin',
    language: 'en',
  },
  matching: { ...DEFAULT_MATCHING },
  cuts: { ...DEFAULT_CUTS },
  export: {
    markAs: 'keyword', // 'keyword' | 'reject' | 'both'
    retakeKeyword: 'Retake Cut',
    uncertainKeyword: 'Maybe Cut',
    addToneMarkers: true,
    eventName: 'ClipPrep',
    timecode: 'auto', // 'auto' | 'source' | 'zero' — see fcpReadsTimecode in fcpxml.js
  },
};

// Deep-merge saved settings over defaults so new options get sensible values.
function withDefaults(saved = {}) {
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    out[k] = v && typeof v === 'object' ? { ...v, ...(saved[k] || {}) } : saved[k] ?? v;
  }
  return out;
}

// Only values that differ from the defaults are saved, so a changed default reaches existing
// installs unless the user has deliberately set that option.
function changedFromDefaults(settings) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    const v = settings[k];
    if (def && typeof def === 'object') {
      const diff = {};
      for (const [kk, dv] of Object.entries(def)) if (v?.[kk] !== undefined && v[kk] !== dv) diff[kk] = v[kk];
      if (Object.keys(diff).length) out[k] = diff;
    } else if (v !== undefined && v !== def) out[k] = v;
  }
  return out;
}

module.exports = { DEFAULT_SETTINGS, withDefaults, changedFromDefaults };
