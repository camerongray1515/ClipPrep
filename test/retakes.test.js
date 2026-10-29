const test = require('node:test');
const assert = require('node:assert');
const { analyzeCuts } = require('../src/core/retakes');

// Build a word list from a script where "[beep]" marks a 2 s cue tone. Words are 0.4 s apart,
// with a 1 s pause either side of each tone.
function script(text) {
  const words = [];
  const tones = [];
  let t = 1;
  for (const tok of text.split(/\s+/)) {
    if (tok === '[beep]') {
      tones.push({ start: t + 0.6, end: t + 2.6 });
      t += 3.6;
    } else {
      words.push({ text: tok, start: t, end: t + 0.35 });
      t += 0.4;
    }
  }
  return { words, tones, duration: t + 1, frames: null };
}

const at = (data, text) => data.words.find((w) => w.text === text).start;
const kept = (data, cuts) =>
  data.words.filter((w) => !cuts.some((c) => w.start >= c.start && w.start < c.end)).map((w) => w.text).join(' ');

test('removes every failed take before the final retake', () => {
  const data = script('The quick brown dog [beep] The quick brown fox ate [beep] The quick brown fox jumped over the lazy dog.');
  const { cuts, details } = analyzeCuts(data);
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].kind, 'retake');
  assert.ok(cuts[0].start <= at(data, 'The'));
  assert.equal(kept(data, cuts), 'The quick brown fox jumped over the lazy dog.');
  assert.deepEqual(details.map((d) => d.kind), ['retake', 'retake']);
});

test('keeps content spoken before the failed take', () => {
  const data = script('Welcome back to the channel. Today we are going to build [beep] Today we will build a robot.');
  const { cuts } = analyzeCuts(data);
  assert.equal(kept(data, cuts), 'Welcome back to the channel. Today we will build a robot.');
});

test('tolerates small wording differences', () => {
  const data = script('So the next step is to flash the firmware onto it [beep] So the next steps are to flash the firmware.');
  const { cuts, details } = analyzeCuts(data);
  assert.equal(details[0].kind, 'retake');
  assert.equal(kept(data, cuts), 'So the next steps are to flash the firmware.');
});

test('falls back to the interrupted sentence when nothing repeats', () => {
  const data = script('That is the setup done. Now plug it in and [beep] Next, connect the cable.');
  const { cuts, details } = analyzeCuts(data);
  assert.equal(details[0].kind, 'uncertain');
  assert.equal(cuts[0].kind, 'uncertain');
  assert.equal(kept(data, cuts), 'That is the setup done. Next, connect the cable.');
});

test('stricter similarity rejects a loose match', () => {
  const data = script('The quick brown dog [beep] The quick brown fox ate');
  const strict = analyzeCuts(data, { phraseSimilarity: 0.9, compareWords: 4 }, { fallback: 'tone' });
  assert.equal(strict.details[0].kind, 'tone');
  assert.equal(kept(data, strict.cuts), 'The quick brown dog The quick brown fox ate');
});

test('per-tone overrides', () => {
  const data = script('The quick brown dog [beep] The quick brown fox.');
  assert.equal(analyzeCuts(data, {}, {}, { 0: { mode: 'off' } }).cuts.length, 0);
  const toneOnly = analyzeCuts(data, {}, {}, { 0: { mode: 'tone' } });
  assert.equal(kept(data, toneOnly.cuts), 'The quick brown dog The quick brown fox.');
});

test('looks past a tone whose preceding take was not transcribed', () => {
  const data = script('Intro words here. And it is showing up in both [beep] [beep] And it is showing up in both apps.');
  const { cuts } = analyzeCuts(data);
  assert.equal(kept(data, cuts), 'Intro words here. And it is showing up in both apps.');
});
