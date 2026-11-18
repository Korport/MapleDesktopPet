const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mapleMicrosoft365', {
  snapshot: () => ipcRenderer.invoke('microsoft365:snapshot'),
  signIn: (config) => ipcRenderer.invoke('microsoft365:sign-in', config),
  disconnect: () => ipcRenderer.invoke('microsoft365:disconnect'),
  openSignIn: () => ipcRenderer.invoke('microsoft365:open-sign-in'),
  onChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('microsoft365:changed', listener);
    return () => ipcRenderer.removeListener('microsoft365:changed', listener);
  },
});
