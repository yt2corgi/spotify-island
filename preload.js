const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  onMedia: (cb) => ipcRenderer.on('media', (_e, msg) => cb(msg)),
  onHover: (cb) => ipcRenderer.on('hover-state', (_e, over) => cb(over)),
  cmd: (c) => ipcRenderer.send('cmd', c),
  zone: (r) => ipcRenderer.send('zone', r),
  menu: () => ipcRenderer.send('menu'),
  openSpotify: () => ipcRenderer.send('open-spotify'),
  saveMode: (m) => ipcRenderer.send('save-mode', m),
  lock: (on) => ipcRenderer.send('interaction-lock', on),
  onMode: (cb) => ipcRenderer.on('set-mode', (_e, m) => cb(m)),
});
