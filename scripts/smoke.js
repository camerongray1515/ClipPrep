// UI smoke test: launches the app, analyses the given clips and saves screenshots.
//   npx electron scripts/smoke.js <outDir> <file>...
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const idx = process.argv.findIndex((a) => a.endsWith('smoke.js'));
const [outDir, ...files] = process.argv.slice(idx + 1);
require('../src/main/main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  process.on('unhandledRejection', (e) => (console.error(e), app.exit(1)));
  await sleep(1000);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    await sleep(800);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
  };
  fs.mkdirSync(outDir, { recursive: true });
  await js(`addFiles(${JSON.stringify(files.map((f) => path.resolve(f)))})`);
  for (let i = 0; i < 600; i++) {
    if (await js(`state.clips.every((c) => c.status === 'ready' || c.status === 'error')`)) break;
    await sleep(1000);
  }
  console.log(await js(`JSON.stringify(state.clips.map((c) => ({ f: c.file.split('/').pop(), s: c.status, e: c.error, cuts: c.view?.cuts.length })))`));
  await js(`seek(30)`);
  await sleep(1500);
  console.log('clip1 video:', await js(`JSON.stringify({ w: video.videoWidth, rs: video.readyState, err: video.error && video.error.code })`));
  await shot('1-first-clip');
  // Override tone 0 to "off" and confirm the cut disappears, then restore.
  const before = await js(`clip(state.selected).view.cuts.length`);
  if (before) {
  await js(`api.setOverride(state.selected, 0, 'off').then((v) => { clip(state.selected).view = v; renderDetail(); })`);
  await sleep(300);
  const after = await js(`clip(state.selected).view.cuts.length`);
  await js(`api.setOverride(state.selected, 0, 'auto').then((v) => { clip(state.selected).view = v; renderDetail(); })`);
  console.log('override off: cuts', before, '->', after);
  // Matching setting change recomputes without re-analysis.
  await js(`onSettingChange('matching.phraseSimilarity', 0.99)`);
  await sleep(1200);
  console.log('strict matching kinds:', await js(`JSON.stringify(clip(state.selected).view.details.map((d) => d.kind))`), 'status', await js(`clip(state.selected).status`));
  await js(`onSettingChange('matching.phraseSimilarity', 0.6)`);
  await sleep(1200);
  // Skip-cuts playback jumps over the first cut.
  const cut = await js(`clip(state.selected).view.cuts[0].end`);
  await js(`skipCuts = true; video.muted = true; seek(clip(state.selected).view.cuts[0].start - 0.5, true)`);
  await sleep(2500);
  console.log('skip playback: now', (await js(`video.currentTime`)).toFixed(2), 'cut end', cut.toFixed(2));
  await js(`video.pause(); skipCuts = false`);
  }
  if (files.length > 1) {
    await js(`select(state.clips[1].file)`);
    await sleep(1500);
    console.log('video error:', await js(`video.error && video.error.code`), 'overlay:', await js(`!document.querySelector('#video-overlay').classList.contains('hidden')`));
    await shot('2-second-clip');
  }
  await js(`document.querySelector('#btn-settings').click()`);
  await shot('3-settings');
  app.quit();
});
