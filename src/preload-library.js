const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listGames: () => ipcRenderer.invoke('games:list'),
  addGame: (g) => ipcRenderer.invoke('games:add', g),
  updateGame: (id, patch) => ipcRenderer.invoke('games:update', id, patch),
  deleteGame: (id) => ipcRenderer.invoke('games:delete', id),
  startGame: (id) => ipcRenderer.invoke('game:start', id),
  openAI: () => ipcRenderer.invoke('ai:open'),
  tts: (opts) => ipcRenderer.invoke('ai:tts', opts),
  pickAudio: () => ipcRenderer.invoke('ai:pickAudio'),
  pickModelPth: () => ipcRenderer.invoke('ai:pickModelPth'),
  connectDanmaku: (url) => ipcRenderer.invoke('dm:connect', url),
  showLoginWin: () => ipcRenderer.invoke('dm:showLogin'),
  hideLoginWin: () => ipcRenderer.invoke('dm:hide'),
  disconnectDanmaku: () => ipcRenderer.invoke('dm:disconnect'),
  chatAI: (cfg) => ipcRenderer.invoke('ai:chat', cfg),
  onDanmaku: (cb) => {
    const l = (_e, line) => cb(line);
    ipcRenderer.on('dm:message', l);
    return () => ipcRenderer.removeListener('dm:message', l);
  },
  onDanmakuStatus: (cb) => {
    const l = (_e, msg) => cb(msg);
    ipcRenderer.on('dm:status', l);
    return () => ipcRenderer.removeListener('dm:status', l);
  }
});
