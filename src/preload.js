const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mascot', {
  dragMove: (dx, dy) => ipcRenderer.send('mascot:drag-move', { dx, dy }),
  setClickThrough: (enabled) => ipcRenderer.send('mascot:set-click-through', enabled),
  askCopilot: (message) => ipcRenderer.invoke('mascot:ask-copilot', message),
  resizeContent: (height) => ipcRenderer.send('mascot:resize-content', height),
});
