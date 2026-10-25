const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listGames: () => ipcRenderer.invoke('games:list'),
  addGame: (g) => ipcRenderer.invoke('games:add', g),
  updateGame: (id, patch) => ipcRenderer.invoke('games:update', id, patch),
  deleteGame: (id) => ipcRenderer.invoke('games:delete', id),
  startGame: (id) => ipcRenderer.invoke('game:start', id),
  openAI: () => ipcRenderer.invoke('ai:open'),
  tts: (opts) => ipcRenderer.invoke('ai:tts', opts),
  sovitsStream: (opts) => ipcRenderer.invoke('ai:sovitsStream', opts),
  onSovitsChunk: (cb) => {
    const l = (_e, chunk) => cb(chunk);
    ipcRenderer.on('ai:sovitsChunk', l);
    return () => ipcRenderer.removeListener('ai:sovitsChunk', l);
  },
  pickAudio: () => ipcRenderer.invoke('ai:pickAudio'),
  mediaList: () => ipcRenderer.invoke('media:list'),
  mediaImport: (src) => ipcRenderer.invoke('media:import', src),
  mediaDelete: (file) => ipcRenderer.invoke('media:delete', file),
  pickRefAudio: () => ipcRenderer.invoke('ai:pickRefAudio'),
  warmup: (refAudio) => ipcRenderer.invoke('ai:warmup', refAudio),
  listVoices: () => ipcRenderer.invoke('ai:listVoices'),
  addVoice: (v) => ipcRenderer.invoke('ai:addVoice', v),
  deleteVoice: (id) => ipcRenderer.invoke('ai:deleteVoice', id),
  updateVoice: (id, v) => ipcRenderer.invoke('ai:updateVoice', id, v),
  connectDanmaku: (url) => ipcRenderer.invoke('dm:connect', url),
  showLoginWin: () => ipcRenderer.invoke('dm:showLogin'),
  hideLoginWin: () => ipcRenderer.invoke('dm:hide'),
  disconnectDanmaku: () => ipcRenderer.invoke('dm:disconnect'),
  openFilterRule: () => ipcRenderer.invoke('dm:filterRule'),
  openDeviceGuide: () => ipcRenderer.invoke('deviceGuide:open'),
  openDeviceDir: () => ipcRenderer.invoke('deviceDir:open'),
  openVoiceQueue: () => ipcRenderer.invoke('voiceQueue:open'),
  syncVoiceQueue: (data) => ipcRenderer.invoke('voiceQueue:sync', data),
  onVoiceQueueClear: (cb) => {
    const l = () => cb();
    ipcRenderer.on('voiceQueue:clear', l);
    return () => ipcRenderer.removeListener('voiceQueue:clear', l);
  },
  onVoiceQueuePause: (cb) => {
    const l = (_e, paused) => cb(paused);
    ipcRenderer.on('voiceQueue:pause', l);
    return () => ipcRenderer.removeListener('voiceQueue:pause', l);
  },
  chatAI: (cfg) => ipcRenderer.invoke('ai:chat', cfg),
  screenCapture: () => ipcRenderer.invoke('screen:capture'),
  cfgLoad: () => ipcRenderer.invoke('cfg:load'),
  cfgSave: (patch) => ipcRenderer.invoke('cfg:save', patch),
  modelList: () => ipcRenderer.invoke('models:list'),
  modelSave: (p) => ipcRenderer.invoke('models:save', p),
  modelDelete: (id) => ipcRenderer.invoke('models:delete', id),
  modelFetchList: (p) => ipcRenderer.invoke('models:fetchList', p),
  openConfigFile: () => ipcRenderer.invoke('models:openConfig'),
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
