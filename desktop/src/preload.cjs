// Preload — runs in every renderer process (sandboxed). Exposes a tiny
// `window.orblood` API for the setup screen, the error page and the app.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orblood', {
  isDesktop: true,
  platform: process.platform,
  getSettings:    () => ipcRenderer.invoke('orblood:getSettings'),
  setBackendUrl:  url => ipcRenderer.invoke('orblood:setBackendUrl', String(url || '')),
  resetBackend:   () => ipcRenderer.invoke('orblood:resetBackend'),
  reload:         () => ipcRenderer.invoke('orblood:reload'),
  openExternal:   url => ipcRenderer.invoke('orblood:openExternal', String(url || ''))
});
