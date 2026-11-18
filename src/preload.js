const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mascot', {
  dragMove: (dx, dy) => ipcRenderer.send('mascot:drag-move', { dx, dy }),
  setClickThrough: (enabled) => ipcRenderer.send('mascot:set-click-through', enabled),
  askCopilot: (message) => ipcRenderer.invoke('mascot:ask-copilot', message),
  onProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('mascot:progress', listener);
    return () => ipcRenderer.removeListener('mascot:progress', listener);
  },
  onNotification: (callback) => {
    const listener = (_event, notification) => callback(notification);
    ipcRenderer.on('mascot:notification', listener);
    return () => ipcRenderer.removeListener('mascot:notification', listener);
  },
  resizeContent: (height) => ipcRenderer.send('mascot:resize-content', height),
});
