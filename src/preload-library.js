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
  toggleLoginWin: () => ipcRenderer.invoke('dm:loginToggle'),
  onDanmakuLoginVisible: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('dm:loginVisible', l);
    return () => ipcRenderer.removeListener('dm:loginVisible', l);
  },
  disconnectDanmaku: () => ipcRenderer.invoke('dm:disconnect'),
  openFilterRule: () => ipcRenderer.invoke('dm:filterRule'),
  injectTestDanmaku: () => ipcRenderer.invoke('dm:test'),
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
  // 配置模板
  tplList: () => ipcRenderer.invoke('tpl:list'),
  tplAdd: (p) => ipcRenderer.invoke('tpl:add', p),
  tplUpdate: (p) => ipcRenderer.invoke('tpl:update', p),
  tplOverwrite: (id) => ipcRenderer.invoke('tpl:overwrite', id),
  tplDelete: (id) => ipcRenderer.invoke('tpl:delete', id),
  tplLoad: (id) => ipcRenderer.invoke('tpl:load', id),
  tplBindGame: (p) => ipcRenderer.invoke('tpl:bindGame', p),
  tplOpenDir: () => ipcRenderer.invoke('tpl:openDir'),
  onTemplateLoaded: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('cfg:templateLoaded', l);
    return () => ipcRenderer.removeListener('cfg:templateLoaded', l);
  },
  onDanmaku: (cb) => {
    const l = (_e, line) => cb(line);
    ipcRenderer.on('dm:message', l);
    return () => ipcRenderer.removeListener('dm:message', l);
  },
  onDanmakuStatus: (cb) => {
    const l = (_e, msg) => cb(msg);
    ipcRenderer.on('dm:status', l);
    return () => ipcRenderer.removeListener('dm:status', l);
  },
  // 明确连接状态：驱动「连接直播间 / 断开」切换按钮
  onDanmakuState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('dm:state', l);
    return () => ipcRenderer.removeListener('dm:state', l);
  },
  // 采集器健康状态（容器是否挂载、累计条数、静默时长、自愈次数）
  onDanmakuHealth: (cb) => {
    const l = (_e, h) => cb(h);
    ipcRenderer.on('dm:health', l);
    return () => ipcRenderer.removeListener('dm:health', l);
  },
  // 阶段0 WS 探针（是否 attach 成功、WS 连接/帧计数）
  onDanmakuProbe: (cb) => {
    const l = (_e, p) => cb(p);
    ipcRenderer.on('dm:probe', l);
    return () => ipcRenderer.removeListener('dm:probe', l);
  }
});
