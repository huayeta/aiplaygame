const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vqAPI', {
  onData: (cb) => {
    const l = (_e, data) => cb(data);
    ipcRenderer.on('voiceQueue:data', l);
    return () => ipcRenderer.removeListener('voiceQueue:data', l);
  },
  clearVoice: () => ipcRenderer.invoke('voiceQueue:clear'),
  pauseVoice: (paused) => ipcRenderer.invoke('voiceQueue:pause', paused)
});
