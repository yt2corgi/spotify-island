const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  onMedia: (cb) => ipcRenderer.on('media', (_e, msg) => cb(msg)),
  onHover: (cb) => ipcRenderer.on('hover-state', (_e, over) => cb(over)),
  cmd: (c) => ipcRenderer.send('cmd', c),
  zone: (r) => ipcRenderer.send('zone', r),
  menu: () => ipcRenderer.send('menu'),
  openSpotify: () => ipcRenderer.send('open-spotify'),
  getQueue: () => ipcRenderer.invoke('queue:get'),
  jump: (args) => ipcRenderer.invoke('queue:jump', args),
  spotifyConnect: () => ipcRenderer.invoke('spotify:connect'),
  onSpotifyConnected: (cb) => ipcRenderer.on('spotify-connected', () => cb()),
});
