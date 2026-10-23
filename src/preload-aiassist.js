const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  tts: (opts) => ipcRenderer.invoke('ai:tts', opts),
  sovitsStream: (opts) => ipcRenderer.invoke('ai:sovitsStream', opts),
  onSovitsChunk: (cb) => {
    const l = (_e, chunk) => cb(chunk);
    ipcRenderer.on('ai:sovitsChunk', l);
    return () => ipcRenderer.removeListener('ai:sovitsChunk', l);
  },
  pickAudio: () => ipcRenderer.invoke('ai:pickAudio'),
  pickModelPth: () => ipcRenderer.invoke('ai:pickModelPth'),
  pickRefAudio: () => ipcRenderer.invoke('ai:pickRefAudio'),
  warmup: (refAudio) => ipcRenderer.invoke('ai:warmup', refAudio)
});
