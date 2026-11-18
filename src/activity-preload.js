const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mapleActivity', {
  snapshot: () => ipcRenderer.invoke('activity:snapshot'),
  download: () => ipcRenderer.invoke('activity:download'),
  usage: () => ipcRenderer.invoke('activity:usage'),
  onUsageChange: (callback) => {
    const listener = (_event, usage) => callback(usage);
    ipcRenderer.on('activity:usage-changed', listener);
    return () => ipcRenderer.removeListener('activity:usage-changed', listener);
  },
  onChange: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('activity:changed', listener);
    return () => ipcRenderer.removeListener('activity:changed', listener);
  },
});
