const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('panel', {
  recStart: () => ipcRenderer.send('rec:start'),
  recMark: () => ipcRenderer.send('rec:mark'),
  recStop: () => ipcRenderer.send('rec:stop'),
  recUndo: () => ipcRenderer.send('rec:undo'),
  recClear: () => ipcRenderer.send('rec:clear'),
  playStart: (startIdx) => ipcRenderer.send('play:start', startIdx || 1),
  playStop: () => ipcRenderer.send('play:stop'),
  toggleMute: (muted) => ipcRenderer.invoke('game:mute', muted),
  aiPlan: (cfg) => ipcRenderer.invoke('aiCtl:plan', cfg),
  aiStart: (plan) => ipcRenderer.send('aiCtl:start', plan),
  aiStop: () => ipcRenderer.send('aiCtl:stop'),
  aiState: () => ipcRenderer.invoke('aiCtl:state'),
  getAICfg: () => ipcRenderer.invoke('aiCfg:get'),
  capture: () => ipcRenderer.send('tpl:capture'),
  setOption: (patch) => ipcRenderer.send('option:set', patch),
  getOption: () => ipcRenderer.invoke('option:get'),
  scriptInfo: () => ipcRenderer.invoke('script:info'),
  scriptReRecord: (idx) => ipcRenderer.send('script:reRecord', idx),
  scriptDeleteLevel: (idx) => ipcRenderer.send('script:deleteLevel', idx),
  scriptTest: (idx) => ipcRenderer.send('script:test', idx),
  onStatus: (cb) => ipcRenderer.on('status', (e, data) => cb(data)),
  onLevels: (cb) => ipcRenderer.on('levels', (e, data) => cb(data))
});
