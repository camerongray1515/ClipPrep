const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { analyzeClip, computeCuts } = require('../core/analyzer');
const { makeProxy } = require('../core/media');
const { readSidecar } = require('../core/sony');
const { buildFcpxml } = require('../core/fcpxml');
const { withDefaults, changedFromDefaults } = require('../core/settings');
const { findWhisper, MODELS, MODEL_URL, WHISPER_INSTALL_HINT } = require('../core/transcribe');

app.setName('ClipPrep');
const dataDir = app.getPath('userData');
const cacheDir = path.join(dataDir, 'cache');
const modelsDir = path.join(dataDir, 'models');
const proxyDir = path.join(dataDir, 'proxies');
const settingsFile = path.join(dataDir, 'settings.json');

let settings = withDefaults(readJson(settingsFile));
const clips = new Map(); // file → { analysis, overrides }
let win;

function readJson(f) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
}

function pipelineSettings() {
  return {
    ...settings,
    transcription: { ...settings.transcription, modelPath: path.join(modelsDir, settings.transcription.model) },
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#16171a',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

const send = (ch, payload) => win && !win.isDestroyed() && win.webContents.send(ch, payload);

// What the renderer needs to draw a clip (frames are downsampled for the waveform).
function clipView(file) {
  const c = clips.get(file);
  const { analysis, overrides } = c;
  const { cuts, details } = computeCuts(analysis, settings, overrides);
  for (const cut of cuts) cut.note = details.filter((d) => cut.tones.includes(d.index)).map((d) => d.retakeText && `Retake: ${d.retakeText}`).filter(Boolean).join(' / ');
  c.cuts = cuts;
  return {
    file,
    url: pathToFileURL(file).href,
    proxyUrl: c.proxy ? pathToFileURL(c.proxy).href : null,
    info: analysis.info,
    tones: analysis.tones,
    words: analysis.words,
    envelope: { hop: analysis.frames.hop, rms: Array.from(analysis.frames.rms) },
    cuts,
    details,
    overrides,
  };
}

ipcMain.handle('settings:get', () => ({ settings, models: MODELS }));

ipcMain.handle('settings:set', (_e, next) => {
  const prev = settings;
  settings = withDefaults(next);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(changedFromDefaults(settings), null, 2));
  // Tone/transcription/audio changes need the pipeline re-run; matching and cut settings don't.
  const needsReanalysis =
    JSON.stringify([prev.audioTrack, prev.tone, prev.transcription]) !==
    JSON.stringify([settings.audioTrack, settings.tone, settings.transcription]);
  return { settings, needsReanalysis };
});

ipcMain.handle('files:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add clips',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mxf', 'MP4', 'MOV'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('clip:analyze', async (_e, file) => {
  const analysis = await analyzeClip(file, pipelineSettings(), {
    cacheDir,
    onProgress: (stage, p) => send('clip:progress', { file, stage, p }),
  });
  const prev = clips.get(file);
  // Keep per-tone overrides only if the tones themselves didn't change.
  const sameTones = prev && JSON.stringify(prev.analysis.tones) === JSON.stringify(analysis.tones);
  clips.set(file, { analysis, overrides: sameTones ? prev.overrides : {}, proxy: prev?.proxy });
  return clipView(file);
});

ipcMain.handle('clip:view', (_e, file) => (clips.has(file) ? clipView(file) : null));

ipcMain.handle('clip:override', (_e, file, toneIndex, mode) => {
  const c = clips.get(file);
  if (mode === 'auto') delete c.overrides[toneIndex];
  else c.overrides[toneIndex] = { mode };
  return clipView(file);
});

ipcMain.handle('clip:remove', (_e, file) => clips.delete(file));

// Camera clip flag (e.g. KEEP / NG) from a Sony M01.XML sidecar; read straight away on import.
ipcMain.handle('clip:camera-status', (_e, file) => readSidecar(file)?.status || null);

ipcMain.handle('clip:proxy', async (_e, file) => {
  const c = clips.get(file);
  fs.mkdirSync(proxyDir, { recursive: true });
  const st = fs.statSync(file);
  const out = path.join(proxyDir, `${path.parse(file).name}-${st.size}-${Math.round(st.mtimeMs)}.mp4`);
  if (!fs.existsSync(out)) {
    const tmp = `${out}.partial.mp4`;
    await makeProxy(file, tmp, c?.analysis.info.duration || 0, (p) => send('clip:progress', { file, stage: 'proxy', p }));
    fs.renameSync(tmp, out);
  }
  if (c) c.proxy = out;
  send('clip:progress', { file, stage: 'done', p: 1 });
  return pathToFileURL(out).href;
});

ipcMain.handle('export:fcpxml', async (_e, files, openInFcp) => {
  const list = files.filter((f) => clips.has(f)).map((f) => {
    clipView(f); // refresh cuts with current settings
    const c = clips.get(f);
    return { file: f, analysis: c.analysis, cuts: c.cuts };
  });
  if (!list.length) return { ok: false, error: 'No analysed clips to export.' };
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  const r = await dialog.showSaveDialog(win, {
    title: 'Export FCPXML',
    defaultPath: path.join(path.dirname(list[0].file), `${settings.export.eventName} ${stamp}.fcpxml`),
    filters: [{ name: 'Final Cut Pro XML', extensions: ['fcpxml'] }],
  });
  if (r.canceled) return { ok: false };
  const eventName = `${settings.export.eventName} ${stamp}`;
  fs.writeFileSync(r.filePath, buildFcpxml(list, { ...settings.export, eventName }));
  if (openInFcp) execFile('open', ['-a', 'Final Cut Pro', r.filePath], () => {});
  return { ok: true, path: r.filePath };
});

ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

// --- Transcription engine status and model downloads ------------------------------------------

ipcMain.handle('engine:status', () => ({
  whisper: findWhisper(settings.transcription.whisperPath),
  installHint: WHISPER_INSTALL_HINT,
  models: MODELS.map((m) => ({ ...m, installed: fs.existsSync(path.join(modelsDir, m.file)) })),
}));

ipcMain.handle('models:download', async (_e, file) => {
  if (!MODELS.some((m) => m.file === file)) throw new Error('Unknown model');
  fs.mkdirSync(modelsDir, { recursive: true });
  const dest = path.join(modelsDir, file);
  const res = await fetch(MODEL_URL(file));
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = `${dest}.partial`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    send('models:progress', { file, p: total ? got / total : 0 });
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(tmp, dest);
  return true;
});
