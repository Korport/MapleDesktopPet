const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mapleActivity', {
  snapshot: () => ipcRenderer.invoke('activity:snapshot'),
  download: () => ipcRenderer.invoke('activity:download'),
  onChange: (callback) => {
    const listener = (_event, text) => callback(text);
    ipcRenderer.on('activity:changed', listener);
    return () => ipcRenderer.removeListener('activity:changed', listener);
  },
});
