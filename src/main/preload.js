const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  pathForFile: (f) => webUtils.getPathForFile(f),
  analyze: (file) => ipcRenderer.invoke('clip:analyze', file),
  view: (file) => ipcRenderer.invoke('clip:view', file),
  setOverride: (file, tone, mode) => ipcRenderer.invoke('clip:override', file, tone, mode),
  removeClip: (file) => ipcRenderer.invoke('clip:remove', file),
  cameraStatus: (file) => ipcRenderer.invoke('clip:camera-status', file),
  makeProxy: (file) => ipcRenderer.invoke('clip:proxy', file),
  exportFcpxml: (files, open) => ipcRenderer.invoke('export:fcpxml', files, open),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  downloadModel: (f) => ipcRenderer.invoke('models:download', f),
  onProgress: on('clip:progress'),
  onModelProgress: on('models:progress'),
});
