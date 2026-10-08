const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tts: (opts) => ipcRenderer.invoke('ai:tts', opts),
  pickAudio: () => ipcRenderer.invoke('ai:pickAudio'),
  pickModelPth: () => ipcRenderer.invoke('ai:pickModelPth')
});
