const { contextBridge, ipcRenderer } = require('electron');

const fullscreenListeners = new Set();

ipcRenderer.on('window:fullscreen-changed', (_event, value) => {
  for (const listener of [...fullscreenListeners]) {
    try {
      listener(Boolean(value));
    } catch (error) {
      console.error('[preload] fullscreen listener error', error);
    }
  }
});

contextBridge.exposeInMainWorld('idupiDesktop', {
  isElectron: true,
  platform: process.platform,
  setFullscreen: (value) => ipcRenderer.invoke('window:set-fullscreen', Boolean(value)),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', String(text ?? '')),
  appInfo: () => ipcRenderer.invoke('app:info'),
  onFullscreenChange: (listener) => {
    if (typeof listener !== 'function') return () => {};
    fullscreenListeners.add(listener);
    return () => fullscreenListeners.delete(listener);
  },
});
