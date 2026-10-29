#!/usr/bin/env node
// Headless runner for the analysis pipeline: node scripts/analyze-cli.js [--fcpxml out.fcpxml] file...
const path = require('path');
const os = require('os');
const fs = require('fs');
const { analyzeClip, computeCuts } = require('../src/core/analyzer');
const { withDefaults } = require('../src/core/settings');

const appData = path.join(os.homedir(), 'Library', 'Application Support', 'ClipPrep');
const args = process.argv.slice(2);
let fcpxmlOut = null;
const fi = args.indexOf('--fcpxml');
if (fi >= 0) fcpxmlOut = args.splice(fi, 2)[1];

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

(async () => {
  const settings = withDefaults();
  settings.transcription.modelPath = path.join(appData, 'models', settings.transcription.model);
  const clips = [];
  for (const file of args) {
    const t0 = Date.now();
    let last = '';
    const a = await analyzeClip(file, settings, {
      cacheDir: path.join(appData, 'cache'),
      onProgress: (stage, p) => {
        const s = `${stage} ${Math.round(p * 100)}%`;
        if (s !== last) process.stderr.write(`\r  ${path.basename(file)}: ${s}      `);
        last = s;
      },
    });
    process.stderr.write('\n');
    const { cuts, details } = computeCuts(a, settings, {});
    clips.push({ file, analysis: a, cuts });
    console.log(`\n=== ${path.basename(file)}  (${fmt(a.info.duration)}, ${a.tones.length} tones, ${a.words.length} words, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    for (const d of details) {
      console.log(`  tone ${fmt(d.tone.start)}-${fmt(d.tone.end)}  [${d.kind}${d.score != null ? ' ' + d.score.toFixed(2) : ''}]`);
      console.log(`     failed: ${d.failedText || '—'}`);
      console.log(`     retake: ${d.retakeText || '—'}`);
    }
    for (const c of cuts) console.log(`  CUT ${fmt(c.start)} → ${fmt(c.end)}  ${c.kind}`);
  }
  if (fcpxmlOut) {
    const { buildFcpxml } = require('../src/core/fcpxml');
    fs.writeFileSync(fcpxmlOut, buildFcpxml(clips, settings.export));
    console.log(`\nWrote ${fcpxmlOut}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
