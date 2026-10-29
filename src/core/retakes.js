// Turns cue tones + a word-level transcript into ranges to cut.
//
// For each tone we look at the words spoken straight after it (the retake) and search the words
// before it (the failed take) for where that same opening phrase was started. Everything from the
// start of the failed take, through the tone, up to the start of the retake is marked for removal.
// Consecutive failed takes chain naturally because each tone's cut overlaps the next.

const { noiseFloor } = require('./audio-analysis');

const DEFAULT_MATCHING = {
  compareWords: 8, // how many opening words of the retake to compare
  minMatchedWords: 3, // a failed take must share at least this many words with the retake
  wordSimilarity: 0.75, // 0–1, per-word fuzzy match (normalised edit distance)
  phraseSimilarity: 0.6, // 0–1, fraction of compared words that must match
  anchorSlack: 1, // retake may begin with this many extra words before the shared phrase
  lookbackSeconds: 90, // how far before a tone to search for the failed take
  ignoreWords: 'um, uh, er, erm, ah, hmm, mm, uhm',
};

const DEFAULT_CUTS = {
  fallback: 'sentence', // when no repeated phrase is found: 'sentence' | 'tone'
  fallbackPause: 0.8, // seconds; a pause this long also counts as a sentence boundary for the fallback
  padBefore: 0.1, // seconds of air kept before the start of a cut
  padAfter: 0.1, // seconds of air kept before the retake starts
  silenceDb: 12, // dB above the noise floor that counts as speech when snapping to silence
};

function normalize(text) {
  return text.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function wordSim(a, b) {
  if (a === b) return 1;
  const len = Math.max(a.length, b.length);
  return len ? 1 - levenshtein(a, b) / len : 1;
}

// Fuzzy longest-common-subsequence on word arrays.
function fuzzyLcs(A, B, thr) {
  const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++)
    for (let j = 1; j <= B.length; j++)
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1] + (wordSim(A[i - 1], B[j - 1]) >= thr ? 1 : 0));
  return dp[A.length][B.length];
}

// Score A (candidate failed-take opening) against B (retake opening). A[0] must match one of the
// first words of B, so the cut starts on the first word of the failed take, not mid-phrase.
function scorePhrase(A, B, m) {
  let best = 0;
  for (let j0 = 0; j0 <= Math.min(m.anchorSlack, B.length - 1); j0++) {
    if (wordSim(A[0], B[j0]) < m.wordSimilarity) continue;
    best = Math.max(best, 1 + fuzzyLcs(A.slice(1), B.slice(j0 + 1), m.wordSimilarity));
  }
  return { matched: best, score: best / Math.min(A.length, B.length) };
}

// Words in [t0, t1) reduced to comparable tokens, keeping a pointer back to the source word.
function tokens(words, t0, t1, ignore) {
  const out = [];
  for (const w of words) {
    if (w.start < t0 || w.start >= t1) continue;
    for (const part of normalize(w.text).split(' ')) {
      if (part && !ignore.has(part)) out.push({ norm: part, word: w });
    }
  }
  return out;
}

function findFailedTake(pre, post, m) {
  const B = post.slice(0, m.compareWords).map((t) => t.norm);
  if (B.length < m.minMatchedWords) return null;
  let best = null;
  for (let p = 0; p < pre.length; p++) {
    const A = pre.slice(p, p + m.compareWords).map((t) => t.norm);
    if (A.length < m.minMatchedWords) break;
    const { matched, score } = scorePhrase(A, B, m);
    if (matched < m.minMatchedWords || score < m.phraseSimilarity) continue;
    // Highest score wins; ties go to the earliest start so repeated false starts are all removed.
    if (!best || score > best.score + 1e-9) best = { p, score, matched, compared: A.length };
  }
  return best;
}

// --- Snapping cut points to silence using the loudness envelope --------------------------------

function envelopeTools(frames, silenceDb) {
  const { hop, rms } = frames;
  const thr = noiseFloor(rms) * Math.pow(10, silenceDb / 20);
  const loud = (t) => {
    const f = Math.floor(t / hop);
    return f >= 0 && f < rms.length && rms[f] > thr;
  };

  // Refine a word onset estimate to the actual start of sound. Whisper often places the first word
  // of a chunk early (in the silence before it), so search forward as far as the following word.
  function onset(t, limitBack, limitForward = t + 0.3) {
    if (!loud(t)) {
      for (let x = t; x < limitForward; x += hop) if (loud(x) && loud(x + hop)) return x;
      return t;
    }
    // Walk back over continuous sound to where it began. Up to 0.5 s catches a short first word
    // whisper missed (e.g. "Here"), but only if that lands on real silence; in connected speech
    // stay within 0.15 s so the end of the previous (good) word isn't clipped.
    let x = t;
    while (x - hop > limitBack && x - t > -0.5 && loud(x - hop)) x -= hop;
    let quietBefore = true;
    for (let y = x - hop; y > x - 0.2 && y > limitBack; y -= hop) if (loud(y)) quietBefore = false;
    if (quietBefore) return x;
    x = t;
    while (x - hop > limitBack && x - t > -0.15 && loud(x - hop)) x -= hop;
    return x;
  }
  // Start of the silence that ends at `t` (i.e. where the previous sound stopped).
  function silenceStart(t, limitBack) {
    let x = t;
    while (x - hop > limitBack && t - x < 2 && !loud(x - hop)) x -= hop;
    return x;
  }
  // Longest continuous silence within [a, b).
  function longestSilence(a, b) {
    let best = 0, run = 0;
    for (let x = a; x < b; x += hop) {
      run = loud(x) ? 0 : run + hop;
      best = Math.max(best, run);
    }
    return best;
  }
  return { onset, silenceStart, longestSilence, loud, hop };
}

function nextWordStart(words, word, limit) {
  const i = words.indexOf(word);
  const next = i >= 0 && i + 1 < words.length ? words[i + 1].start : limit;
  return Math.min(next, limit, word.start + 5);
}

function analyzeCuts({ words, tones, frames, duration }, matchingSettings = {}, cutSettings = {}, overrides = {}) {
  const m = { ...DEFAULT_MATCHING, ...matchingSettings };
  const c = { ...DEFAULT_CUTS, ...cutSettings };
  const ignore = new Set(String(m.ignoreWords).split(/[\s,]+/).map(normalize).filter(Boolean));
  const env = frames ? envelopeTools(frames, c.silenceDb) : null;

  const details = [];
  const raw = [];

  tones.forEach((tone, i) => {
    const nextStart = i + 1 < tones.length ? tones[i + 1].start : duration;
    // Search the stretch since the previous tone; if whisper found no words there at all, keep
    // looking back past earlier tones (within the lookback window).
    let k = i;
    let prevEnd = k > 0 ? tones[k - 1].end : 0;
    let pre = tokens(words, Math.max(prevEnd, tone.start - m.lookbackSeconds), tone.start, ignore);
    while (!pre.length && k > 0 && tone.start - tones[k - 1].start < m.lookbackSeconds) {
      k--;
      prevEnd = k > 0 ? tones[k - 1].end : 0;
      pre = tokens(words, Math.max(prevEnd, tone.start - m.lookbackSeconds), tone.start, ignore);
    }
    const post = tokens(words, tone.end, nextStart, ignore);
    const mode = overrides[i]?.mode || 'auto';

    const detail = { index: i, tone, mode, kind: 'tone', score: null, failedText: '', retakeText: '' };
    detail.retakeText = [...new Set(post.slice(0, m.compareWords).map((t) => t.word))].map((w) => w.text).join(' ');
    details.push(detail);
    if (mode === 'off') return;

    let startWord = null;
    if (mode === 'auto') {
      const match = findFailedTake(pre, post, m);
      if (match) {
        startWord = pre[match.p].word;
        detail.kind = 'retake';
        detail.score = match.score;
      }
    }
    if (!startWord && (mode === 'sentence' || (mode === 'auto' && c.fallback === 'sentence')) && pre.length) {
      // Back to the start of the sentence (or phrase after a pause) that the tone interrupted.
      const pauseBefore = (k) => {
        const a = pre[k - 1].word, b = pre[k].word;
        return env ? env.longestSilence(a.start, b.start) : b.start - a.end;
      };
      let k = pre.length - 1;
      while (k > 0 && !/[.?!]$/.test(pre[k - 1].word.text) && pauseBefore(k) < c.fallbackPause) k--;
      startWord = pre[k].word;
      detail.kind = 'uncertain';
    }
    if (startWord) {
      detail.failedText = words.filter((w) => w.start >= startWord.start && w.start < tone.start).map((w) => w.text).join(' ');
    }

    // Cut start: onset of the failed take's first word (or the tone itself), with some air kept.
    let start = tone.start - 0.05;
    if (startWord) {
      start = startWord.start;
      if (env) {
        const on = env.onset(startWord.start, prevEnd, nextWordStart(words, startWord, tone.start));
        const gapStart = env.silenceStart(on, prevEnd);
        start = Math.max(on - c.padBefore, (gapStart + on) / 2);
      }
      start = Math.min(start, tone.start);
    }

    // Cut end: just before the retake starts (or end of clip if nothing follows the tone).
    let end = post.length ? post[0].word.start : nextStart;
    if (post.length && env) end = env.onset(end, tone.end, nextWordStart(words, post[0].word, nextStart)) - c.padAfter;
    end = Math.max(end, tone.end + 0.05);

    raw.push({ start: Math.max(0, start), end: Math.min(duration, end), kind: detail.kind, tones: [i] });
  });

  // Merge overlapping cuts; a merged range is only "retake" if every part of it was confident.
  raw.sort((a, b) => a.start - b.start);
  const cuts = [];
  for (const r of raw) {
    const last = cuts[cuts.length - 1];
    if (last && r.start <= last.end + 0.05) {
      last.end = Math.max(last.end, r.end);
      last.tones.push(...r.tones);
      if (last.kind !== r.kind) last.kind = last.kind === 'uncertain' || r.kind === 'uncertain' ? 'uncertain' : 'retake';
    } else cuts.push({ ...r });
  }
  // A cut that only covers tones (no transcript evidence either way) is still a definite cut.
  for (const cut of cuts) if (cut.kind === 'tone') cut.kind = 'retake';

  return { cuts, details };
}

module.exports = { analyzeCuts, scorePhrase, normalize, wordSim, DEFAULT_MATCHING, DEFAULT_CUTS };
