const { app, BrowserWindow, ipcMain, nativeImage, Menu, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const ROOT = app.getAppPath();
const DATA_DIR = path.join(ROOT, 'src');
const GAMES_FILE = path.join(ROOT, 'config', 'games.json'); // 游戏库独立配置文件
const AUTOPLAY_FILE = path.join(ROOT, 'config', 'autoplay.json'); // 每个游戏独立的自动玩配置
const VOICES_FILE = path.join(ROOT, 'config', 'voices.json'); // 音色库配置（用户数据）
const SCRIPTS_DIR = path.join(ROOT, 'config', 'scripts'); // 各游戏关卡脚本（用户数据）
const MEDIA_DIR = path.join(ROOT, 'config', 'media'); // 背景音乐素材库
const TPL_DIR = path.join(ROOT, 'templates');

const GAME_W = 414;
const GAME_H = 736; // 9:16

let libraryWin = null;
let gameWin = null;
let panelWin = null;
let aiassistWin = null;
let filterRuleWin = null;
let voiceQueueWin = null;
let voiceQueueData = null; // 最近一次队列快照（library 渲染进程同步过来）
let deviceGuideWin = null;

const auto = {
  gameId: null,
  recording: false,
  playing: false,
  cdpAttached: false,
  script: null,
  lastTapTime: 0,
  abort: false,
  highlight: 0, // 当前正在测试/推进的关（1 基，0=无）
  options: { method: 'cdp', speed: 1, loop: true, threshold: 0.9, autoMark: false, freshStart: false }
};
const DEFAULT_OPTIONS = Object.assign({}, auto.options); // 自动玩默认配置（未单独设置的游戏用它）

[ SCRIPTS_DIR, TPL_DIR ].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} });

// ---------- 工具 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readGames() {
  try { return JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8')); } catch (e) { return []; }
}
function writeGames(list) {
  try { fs.mkdirSync(path.dirname(GAMES_FILE), { recursive: true }); } catch (e) {}
  fs.writeFileSync(GAMES_FILE, JSON.stringify(list, null, 2), 'utf8');
}
// ---------- 每个游戏的自动玩配置（config/autoplay.json） ----------
// 结构：{ "default": {通用默认}, "<gameId>": {该游戏改动的字段} }
// 生效配置 = 代码默认 ← 通用default ← 游戏单独改动的字段，逐层覆盖
function readAutoplayConfig() {
  try { return JSON.parse(fs.readFileSync(AUTOPLAY_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeAutoplayConfig(map) {
  try { fs.mkdirSync(path.dirname(AUTOPLAY_FILE), { recursive: true }); } catch (e) {}
  fs.writeFileSync(AUTOPLAY_FILE, JSON.stringify(map, null, 2), 'utf8');
}
// 通用层：代码默认 + 用户编辑的 default 键
function effectiveDefault(map) {
  return Object.assign({}, DEFAULT_OPTIONS, map.default || {});
}
// 加载某游戏的生效配置（通用 + 该游戏差异合并）
function loadGameOptions(gameId) {
  const map = readAutoplayConfig();
  return Object.assign({}, effectiveDefault(map), map[gameId] || {});
}
// 把当前 auto.options 按「差异」保存：只存该游戏跟通用配置不同的字段，没改过的走通用
function saveGameOptions() {
  if (!auto.gameId) return;
  const map = readAutoplayConfig();
  const base = effectiveDefault(map);
  const diff = {};
  let hasDiff = false;
  for (const k of Object.keys(DEFAULT_OPTIONS)) {
    if (auto.options[k] !== base[k]) { diff[k] = auto.options[k]; hasDiff = true; }
  }
  if (hasDiff) map[auto.gameId] = diff; else delete map[auto.gameId];
  writeAutoplayConfig(map);
}
// ---------- 音色库 ----------
function readVoices() {
  try { return JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8')); } catch (e) { return []; }
}
function writeVoices(list) {
  fs.writeFileSync(VOICES_FILE, JSON.stringify(list, null, 2), 'utf8');
}
ipcMain.handle('ai:listVoices', () => readVoices());
ipcMain.handle('ai:addVoice', async (e, v) => {
  const list = readVoices();
  const name = String(v && v.name || '').trim();
  const refAudio = String(v && v.refAudio || '').trim();
  if (!name) return { ok: false, err: '请填写音色名称' };
  if (!refAudio) return { ok: false, err: '请选择参考音频' };
  // 复制到 config/voices 目录，避免原始文件被移动/删除导致失效
  const voicesDir = path.join(ROOT, 'config', 'voices');
  try { fs.mkdirSync(voicesDir, { recursive: true }); } catch (e) {}
  let storedPath = refAudio;
  try {
    const ext = path.extname(refAudio) || '.wav';
    const dest = path.join(voicesDir, `voice_${Date.now()}_${name.replace(/[\\/:*?"<>|]/g, '_')}${ext}`);
    fs.copyFileSync(refAudio, dest);
    storedPath = dest;
  } catch (e) { /* 复制失败则沿用原路径 */ }
  const rec = { id: Date.now().toString(), name, refAudio: storedPath, promptText: String(v && v.promptText || '').trim(), createdAt: Date.now() };
  list.push(rec);
  writeVoices(list);
  return { ok: true, voice: rec, list };
});
ipcMain.handle('ai:deleteVoice', async (e, id) => {
  let list = readVoices();
  const rec = list.find(x => x.id === id);
  list = list.filter(x => x.id !== id);
  writeVoices(list);
  if (rec && rec.refAudio && rec.refAudio.startsWith(path.join(ROOT, 'config', 'voices'))) {
    try { fs.unlinkSync(rec.refAudio); } catch (e) {}
  }
  return { ok: true, list };
});
ipcMain.handle('ai:updateVoice', async (e, id, v) => {
  const list = readVoices();
  const rec = list.find(x => x.id === id);
  if (!rec) return { ok: false, err: '音色不存在' };
  const name = String(v && v.name || '').trim();
  if (!name) return { ok: false, err: '请填写音色名称' };
  rec.name = name;
  rec.promptText = String(v && v.promptText || '').trim();
  const newAudio = String(v && v.refAudio || '').trim();
  if (newAudio && newAudio !== rec.refAudio) {
    const voicesDir = path.join(ROOT, 'config', 'voices');
    try { fs.mkdirSync(voicesDir, { recursive: true }); } catch (e) {}
    let storedPath = newAudio;
    try {
      const ext = path.extname(newAudio) || '.wav';
      const dest = path.join(voicesDir, `voice_${Date.now()}_${name.replace(/[\\/:*?"<>|]/g, '_')}${ext}`);
      fs.copyFileSync(newAudio, dest);
      storedPath = dest;
    } catch (e) { /* 复制失败则沿用新路径 */ }
    // 若原文件是本库内复制品且被替换，删除旧副本
    if (rec.refAudio && rec.refAudio.startsWith(path.join(ROOT, 'config', 'voices')) && rec.refAudio !== storedPath) {
      try { fs.unlinkSync(rec.refAudio); } catch (e) {}
    }
    rec.refAudio = storedPath;
  }
  writeVoices(list);
  return { ok: true, voice: rec, list };
});
function setStatus(text, extra = {}) {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('status', { text, ...extra, recording: auto.recording, playing: auto.playing });
  }
}

// ---------- 游戏库窗口 ----------
function createLibrary() {
  libraryWin = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1020',
    title: 'AI游戏智播',
    webPreferences: {
      preload: path.join(DATA_DIR, 'preload-library.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  libraryWin.setMenuBarVisibility(false);
  libraryWin.loadFile(path.join(DATA_DIR, 'library.html'));
  libraryWin.webContents.on('console-message', (_e, level, message) => {
    console.log('[library-console] ' + message);
  });
  libraryWin.webContents.on('did-finish-load', () => {
    libraryWin.webContents.executeJavaScript(`(() => {
      const r = {};
      r.viewDevice = !!document.getElementById('viewDevice');
      r.navDevice = !!document.getElementById('navDevice');
      r.deviceOut = !!document.getElementById('deviceOut');
      const vd = document.getElementById('viewDevice');
      if (vd) {
        r.viewDeviceDisp = getComputedStyle(vd).display;
        const chain = [];
        let p = vd.parentElement;
        while (p) { chain.push((p.id ? '#'+p.id : '') + (p.className ? '.'+p.className : '') + '<' + p.tagName + '>'); p = p.parentElement; }
        r.ancestors = chain.join(' → ');
      }
      return JSON.stringify(r);
    })()`).then(s => console.log('[dom-check] ' + s)).catch(e => console.log('[dom-check-err] ' + e));
    libraryWin.webContents.executeJavaScript(`(() => {
      const ids = ['main','viewLibrary','viewAI','viewVoice','viewDanmaku','viewDevice','mask'];
      const out = {};
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) { out[id] = 'MISSING'; continue; }
        const chain = [];
        let p = el;
        while (p) { chain.push((p.id ? '#'+p.id : '') + (p.className ? '.'+p.className.split(' ')[0] : '') + '<' + p.tagName + '>'); p = p.parentElement; }
        out[id] = { disp: getComputedStyle(el).display, chain: chain.join(' → ') };
      }
      return JSON.stringify(out);
    })()`).then(s => console.log('[dom-tree] ' + s)).catch(e => console.log('[dom-tree-err] ' + e));
  });
  libraryWin.on('closed', () => { libraryWin = null; });
}

// ---------- 弹幕过滤规则窗口（标准窗口，可拖动/可调大小） ----------
function createFilterRule() {
  if (filterRuleWin && !filterRuleWin.isDestroyed()) { filterRuleWin.focus(); return; }
  filterRuleWin = new BrowserWindow({
    width: 460,
    height: 620,
    minWidth: 360,
    minHeight: 400,
    backgroundColor: '#171830',
    title: '弹幕过滤规则',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  filterRuleWin.setMenuBarVisibility(false);
  filterRuleWin.loadFile(path.join(DATA_DIR, 'filter-rule.html'));
  filterRuleWin.on('closed', () => { filterRuleWin = null; });
}

// ---------- 虚拟声卡使用指南窗口（标准窗口，静态展示） ----------
function createDeviceGuide() {
  if (deviceGuideWin && !deviceGuideWin.isDestroyed()) {
    deviceGuideWin.loadFile(path.join(DATA_DIR, 'device-guide.html'));
    deviceGuideWin.focus();
    return;
  }
  deviceGuideWin = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 440,
    minHeight: 460,
    backgroundColor: '#171830',
    title: '虚拟声卡安装与配置指南',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  deviceGuideWin.setMenuBarVisibility(false);
  deviceGuideWin.loadFile(path.join(DATA_DIR, 'device-guide.html'));
  deviceGuideWin.on('closed', () => { deviceGuideWin = null; });
}

// ---------- 语音队列窗口（标准窗口，实时显示） ----------
function createVoiceQueue() {
  if (voiceQueueWin && !voiceQueueWin.isDestroyed()) { voiceQueueWin.focus(); return; }
  voiceQueueWin = new BrowserWindow({
    width: 420,
    height: 560,
    minWidth: 340,
    minHeight: 360,
    backgroundColor: '#171830',
    title: '语音队列',
    webPreferences: {
      preload: path.join(DATA_DIR, 'preload-voicequeue.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  voiceQueueWin.setMenuBarVisibility(false);
  voiceQueueWin.loadFile(path.join(DATA_DIR, 'voice-queue.html'));
  // 打开时立即推一次最近快照
  voiceQueueWin.webContents.on('did-finish-load', () => {
    if (voiceQueueData && !voiceQueueWin.isDestroyed()) voiceQueueWin.webContents.send('voiceQueue:data', voiceQueueData);
  });
  voiceQueueWin.on('closed', () => { voiceQueueWin = null; });
}

// ---------- AI 助播窗口 ----------
function createAI() {
  if (aiassistWin && !aiassistWin.isDestroyed()) { aiassistWin.focus(); return; }
  aiassistWin = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 840,
    minHeight: 620,
    backgroundColor: '#0f1020',
    title: 'AI 助播',
    webPreferences: {
      preload: path.join(DATA_DIR, 'preload-aiassist.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  aiassistWin.setMenuBarVisibility(false);
  aiassistWin.loadFile(path.join(DATA_DIR, 'ai-assist.html'));
  aiassistWin.on('closed', () => { aiassistWin = null; });
}

// ---------- AI 助播：文本朗读 / 定时播报 / 背景音乐 ----------
const VOICE_TMP = path.join(os.tmpdir(), 'aiassist_voice');
try { fs.mkdirSync(VOICE_TMP, { recursive: true }); } catch (e) {}

ipcMain.handle('ai:open', () => createAI());

// 用免费 edge-tts 云端合成语音，返回本地 file:// 音频 URL
ipcMain.handle('ai:tts', async (e, opts) => {
  const text = String(opts && opts.text || '').trim();
  if (!text) return { ok: false, err: '文案为空' };
  const engine = (opts && opts.engine) || 'edge';
  const speed = Number(opts && opts.speed) || 1; // 0.5 ~ 2.0
  const dir = path.join(VOICE_TMP, String(Date.now()));
  try {
    fs.mkdirSync(dir, { recursive: true });

    if (engine === 'sovits') {
      // 本地 GPT-SoVITS 引擎：调用 127.0.0.1:9880
      const refAudio = String(opts && opts.refAudio || '').trim();
      if (!refAudio) return { ok: false, err: '本地引擎需先选择参考音频（音色）' };
      const outPath = path.join(dir, 'tts.wav');
      const inferParams = {};
      if (Number(opts.temperature)) inferParams.temperature = Number(opts.temperature);
      if (Number(opts.topK)) inferParams.top_k = Math.round(Number(opts.topK));
      if (Number(opts.sampleSteps)) inferParams.sample_steps = Math.round(Number(opts.sampleSteps));
      const ok = await sovitsTts(text, refAudio, outPath, speed, inferParams);
      if (!ok) return { ok: false, err: '本地 GPT-SoVITS 合成失败（请确认 127.0.0.1:9880 服务已启动）' };
      return { ok: true, url: pathToFileURL(outPath).href };
    }

    // 默认：edge-tts 云端微软晓晓
    const voice = (opts && opts.voice) || 'zh-CN-XiaoxiaoNeural';
    const ratePct = Math.max(-50, Math.min(100, Math.round((speed - 1) * 100)));
    const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const r = await tts.toFile(dir, text, { rate: rateStr, volume: '+0%', pitch: '+0Hz' });
    return { ok: true, url: pathToFileURL(r.audioFilePath).href };
  } catch (err) {
    return { ok: false, err: String((err && err.message) || err) };
  }
});

// 调用本地 GPT-SoVITS api_v2.py 的 /tts 接口，合成并保存为 wav
function sovitsTts(text, refAudio, outPath, speed, inferParams) {
  // 参考文本：从音色库按参考音频匹配补全
  let promptText = '';
  try {
    const voices = JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8'));
    const hit = (voices || []).find(v => v.refAudio === refAudio);
    if (hit && hit.promptText) promptText = String(hit.promptText).trim();
  } catch (e) {}
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      text,
      text_lang: 'zh',
      ref_audio_path: refAudio,
      prompt_lang: 'zh',
      prompt_text: promptText,
      media_type: 'wav',
      speed_factor: Number(speed) || 1,
      streaming_mode: 0,
      ...(inferParams || {}) // temperature / top_k / sample_steps
    });
    const req = http.request({
      host: '127.0.0.1', port: 9880, path: '/tts',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { fs.writeFileSync(outPath, Buffer.concat(chunks)); resolve(true); } catch (err) { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.write(payload);
    req.end();
  });
}

ipcMain.handle('ai:pickAudio', async () => {
  const res = await dialog.showOpenDialog(aiassistWin || libraryWin, {
    title: '选择背景音乐', properties: ['openFile'],
    filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------- 背景音乐素材库（config/media） ----------
// 用 ffprobe 读音频时长（秒），失败返回 0
function probeDuration(file) {
  return new Promise(res => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 10000 }, (err, stdout) => {
      if (err) return res(0);
      const d = parseFloat(String(stdout || '').trim());
      res(isFinite(d) && d > 0 ? d : 0);
    });
  });
}
// 列出 media 目录下的所有音频（含名称/大小/时长）
ipcMain.handle('media:list', async () => {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const exts = /\.(mp3|wav|ogg|m4a|flac)$/i;
    const files = fs.readdirSync(MEDIA_DIR).filter(f => exts.test(f));
    const items = await Promise.all(files.map(async f => {
      const p = path.join(MEDIA_DIR, f);
      let size = 0;
      try { size = fs.statSync(p).size; } catch (e) {}
      const duration = await probeDuration(p);
      return { path: p, name: f, size, duration };
    }));
    return items;
  } catch (e) { return []; }
});
// 把选中的音乐复制进 media 库：用歌曲文件名命名，重名自动加序号（xxx.mp3 → xxx (1).mp3）
ipcMain.handle('media:import', async (e, src) => {
  if (!src) return { ok: false, err: '未选择文件' };
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const ext = path.extname(src) || '.mp3';
    let name = path.basename(src, ext).replace(/[\\/:*?"<>|]/g, '_') || 'music';
    let dest = path.join(MEDIA_DIR, name + ext);
    let n = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(MEDIA_DIR, `${name} (${n})${ext}`);
      n++;
    }
    fs.copyFileSync(src, dest);
    return { ok: true, path: dest, name: path.basename(dest) };
  } catch (e) {
    return { ok: false, err: '复制失败：' + e.message };
  }
});
// 从 media 库删除选中音乐（同步删除本地文件）
ipcMain.handle('media:delete', async (e, file) => {
  if (!file || !file.startsWith(MEDIA_DIR)) return { ok: false, err: '非法路径' };
  try { fs.unlinkSync(file); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; }
});

// 预热本地 GPT-SoVITS 参考音频缓存：调用 GET /set_refer_audio 提前把特征加载进内存
ipcMain.handle('ai:warmup', async (e, refAudio) => {
  const ref = String(refAudio || '').trim();
  if (!ref) return { ok: false, err: '请先选择参考音频' };
  return new Promise((resolve) => {
    const qs = encodeURIComponent(ref);
    const req = http.request({ host: '127.0.0.1', port: 9880, path: '/set_refer_audio?refer_audio_path=' + qs, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 200) { try { const j = JSON.parse(body); resolve({ ok: true, msg: (j && j.message) || 'ok' }); } catch (e) { resolve({ ok: true, msg: 'ok' }); } }
        else resolve({ ok: false, err: '预热失败：' + body.slice(0, 200) });
      });
    });
    req.on('error', (err) => resolve({ ok: false, err: '本地 GPT-SoVITS 服务未启动（127.0.0.1:9880）' }));
    req.end();
  });
});

// 流式 TTS：请求 streaming_mode=2 返回 raw PCM，边收边推给渲染进程，实现先出声后补全
ipcMain.handle('ai:sovitsStream', async (e, opts) => {
  const text = String(opts && opts.text || '').trim();
  const refAudio = String(opts && opts.refAudio || '').trim();
  const speed = Number(opts && opts.speed) || 1;
  const minChunk = Math.max(10, Math.min(100, Number(opts && opts.minChunk) || 40)); // 流式切块大小，客户端可调（10~100）
  const temperature = Number(opts && opts.temperature); // 越低越稳，过高会"飘"
  const topK = Number(opts && opts.topK);               // 用词合理性
  const sampleSteps = Number(opts && opts.sampleSteps); // 采样步数，越高越自然但越慢
  const tParams = {};
  if (temperature && temperature > 0) tParams.temperature = temperature;
  if (topK && topK > 0) tParams.top_k = Math.round(topK);
  if (sampleSteps && sampleSteps > 0) tParams.sample_steps = Math.round(sampleSteps);
  if (!text) return { ok: false, err: '文案为空' };
  if (!refAudio) return { ok: false, err: '本地引擎需先选择参考音频（音色）' };
  // 参考文本：优先用传入的，否则在音色库里按 refAudio 匹配补全
  let promptText = String(opts && opts.promptText || '').trim();
  if (!promptText) {
    try {
      const voices = JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8'));
      const hit = (voices || []).find(v => v.refAudio === refAudio);
      if (hit && hit.promptText) promptText = String(hit.promptText).trim();
    } catch (e) {}
  }
  const target = (libraryWin && !libraryWin.isDestroyed()) ? libraryWin : (aiassistWin && !aiassistWin.isDestroyed() ? aiassistWin : null);
  if (!target) return { ok: false, err: '窗口不可用' };
  const send = (chunk) => { try { if (!target.isDestroyed()) target.webContents.send('ai:sovitsChunk', chunk); } catch (e) {} };
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      text, text_lang: 'zh', ref_audio_path: refAudio, prompt_lang: 'zh', prompt_text: promptText,
      media_type: 'raw', speed_factor: Number(speed) || 1, streaming_mode: 2,
      min_chunk_length: minChunk,  // 流式切块，客户端可配置
      text_split_method: 'cut5', // 按所有标点切，保证每句尽量小、首块快（秒出）
      ...tParams // temperature / top_k / sample_steps（客户端可调）
    });
    const req = http.request({
      host: '127.0.0.1', port: 9880, path: '/tts', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      if (res.statusCode !== 200) {
        let b = ''; res.on('data', c => b += c); res.on('end', () => { resolve({ ok: false, err: '本地合成失败：' + b.slice(0, 200) }); });
        return;
      }
      const sr = 32000; // GPT-SoVITS v2 输出采样率（实测 wav 头为 32000）
      let pending = Buffer.alloc(0); // 字节对齐：16-bit PCM 每帧 2 字节，奇数尾部留到下次
      res.on('data', (c) => {
        pending = Buffer.concat([pending, c]);
        const even = pending.length - (pending.length % 2);
        if (even > 0) { send({ type: 'chunk', sr, buf: pending.slice(0, even).toString('base64') }); pending = pending.slice(even); }
      });
      res.on('end', () => { if (pending.length > 0) send({ type: 'chunk', sr, buf: pending.toString('base64') }); send({ type: 'end', sr }); resolve({ ok: true }); });
    });
    req.on('error', () => resolve({ ok: false, err: '本地 GPT-SoVITS 服务未启动（127.0.0.1:9880）' }));
    req.write(payload); req.end();
  });
});

// 选择本地 GPT-SoVITS 参考音频（决定音色）
ipcMain.handle('ai:pickRefAudio', async () => {
  const res = await dialog.showOpenDialog(aiassistWin || libraryWin, {
    title: '选择参考音频（音色，5-10秒人声）', properties: ['openFile'],
    filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------- 游戏窗口 + 控制面板 ----------
async function startGame(game) {
  closeGameWindows();
  auto.gameId = game.id;
  auto.options = loadGameOptions(game.id); // 加载该游戏独立的自动玩配置
  saveGameOptions(); // 打开即落盘，确保 config/autoplay.json 存在、可手动编辑

  const display = require('electron').screen.getPrimaryDisplay();
  const wa = display.workArea;
  const gameX = wa.x + Math.round((wa.width - GAME_W - 320) / 2);
  const gameY = wa.y + 20;

  gameWin = new BrowserWindow({
    width: GAME_W,
    height: GAME_H,
    x: gameX,
    y: gameY,
    resizable: false,
    fullscreenable: false,
    backgroundColor: '#ffffff',
    title: game.name,
    useContentSize: true,
    webPreferences: {
      preload: path.join(DATA_DIR, 'preload-game.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false
    }
  });
  gameWin.setMenuBarVisibility(false);
  // 关键：使用桌面 UA，不伪装手机，否则游戏判定 isMobileEmulation 会 halt
  // 「总是重新开始新游戏」开=每次默认新游戏；关=默认继续存档进度（不再弹窗询问）
  const fresh = !!auto.options.freshStart;
  if (fresh) await clearGameStorage(game.url, gameWin);
  gameWin.loadURL(game.url);
  gameWin.on('closed', () => {
    gameWin = null;
    stopPlayback();
    if (panelWin && !panelWin.isDestroyed()) panelWin.close();
  });

  panelWin = new BrowserWindow({
    width: 300,
    height: GAME_H,
    x: gameX + GAME_W + 10,
    y: gameY,
    resizable: false,
    fullscreenable: false,
    backgroundColor: '#15162a',
    title: '自动玩控制台',
    useContentSize: true,
    webPreferences: {
      preload: path.join(DATA_DIR, 'preload-panel.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  panelWin.setMenuBarVisibility(false);
  panelWin.loadFile(path.join(DATA_DIR, 'panel.html'));
  panelWin.on('closed', () => { panelWin = null; });
}

function closeGameWindows() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.destroy();
  if (gameWin && !gameWin.isDestroyed()) gameWin.destroy();
  panelWin = null;
  gameWin = null;
}

// 清除游戏本地存档（localStorage / cookies / IndexedDB 等），实现每次打开都是新游戏
async function clearGameStorage(url, win) {
  const ses = win.webContents.session;
  const storages = ['localstorage', 'sessionstorage', 'cookies', 'indexdb', 'cachestorage', 'serviceworkers'];
  const origins = new Set();
  try {
    const u = new URL(url);
    origins.add(u.origin);
    const parts = u.hostname.split('.');
    if (parts.length >= 2) {
      const base = parts.slice(-2).join('.');
      origins.add(u.protocol + '//h5.' + base);
      origins.add(u.protocol + '//game.' + base);
    }
  } catch (e) {}
  for (const origin of origins) {
    try { await ses.clearStorageData({ origin, storages }); } catch (e) {}
  }
}

// ---------- 点击注入 ----------
// 注入到页面的软点击函数：在 Unity canvas 上派发鼠标/指针事件
const tapFn = function (x, y) {
  var c = document.getElementById('unity-canvas') || document.elementFromPoint(x, y);
  function fire(type, Ctor, opts) {
    try { c.dispatchEvent(new Ctor(type, opts)); } catch (e) {}
  }
  var base = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, view: window };
  var down = Object.assign({ buttons: 1 }, base);
  var up = Object.assign({ buttons: 0 }, base);
  fire('pointerdown', PointerEvent, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, down));
  fire('mousedown', MouseEvent, down);
  fire('pointerup', PointerEvent, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, up));
  fire('mouseup', MouseEvent, up);
  fire('click', MouseEvent, up);
};

async function softTap(x, y) {
  const js = `(${tapFn.toString()})(${x},${y})`;
  if (gameWin && !gameWin.isDestroyed()) {
    await gameWin.webContents.executeJavaScript(js, true);
  }
}

async function cdpTap(x, y) {
  if (!gameWin || gameWin.isDestroyed()) return;
  const dbg = gameWin.webContents.debugger;
  if (!auto.cdpAttached) {
    await dbg.attach('1.3');
    auto.cdpAttached = true;
    dbg.on('detach', () => { auto.cdpAttached = false; });
  }
  // 关键：先移动到目标，再按下、抬起（Unity 需要先有 move）
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(60);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function doTap(x, y) {
  if (auto.options.method === 'cdp') await cdpTap(x, y);
  else await softTap(x, y);
}

// ---------- 画面相似度（用于判定过关/切屏） ----------
async function signature() {
  if (!gameWin || gameWin.isDestroyed()) return null;
  const page = await gameWin.webContents.capturePage();
  const small = page.resize({ width: 20, height: 36 });
  const bmp = small.toBitmap();
  const n = 20 * 36;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    g[i] = (0.299 * bmp[o] + 0.587 * bmp[o + 1] + 0.114 * bmp[o + 2]) / 255;
  }
  return g;
}
function similarity(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += 1 - Math.abs(a[i] - b[i]);
  return s / a.length;
}
async function waitForChange(threshold, timeout = 8000) {
  const start = await signature();
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (auto.abort) return false;
    await sleep(300);
    const cur = await signature();
    if (similarity(start, cur) < threshold) {
      await sleep(500);
      return true;
    }
  }
  return false;
}

// ---------- 录制 ----------
function startRecording() {
  auto.script = {
    gameId: auto.gameId,
    window: { w: GAME_W, h: GAME_H },
    levels: [ { name: 'L1', taps: [] } ],
    recordedAt: new Date().toISOString()
  };
  auto.recording = true;
  auto.lastTapTime = Date.now();
  if (auto.options.autoMark) startAutoMark();
  setStatus('录制中… 自动标记已' + (auto.options.autoMark ? '开启' : '关闭') + '，画面切到新棋盘会自动分关');
}
function markLevel() {
  if (!auto.recording || !auto.script) return;
  const n = auto.script.levels.length + 1;
  auto.script.levels.push({ name: 'L' + n, taps: [] });
  setStatus('第 ' + (n - 1) + ' 关已封存，开始录第 ' + n + ' 关');
}
function stopRecording() {
  if (!auto.recording) return;
  auto.recording = false;
  stopAutoMark();
  saveScript(auto.gameId, auto.script);
  const taps = auto.script.levels.reduce((s, l) => s + l.taps.length, 0);
  setStatus('已保存脚本：' + auto.script.levels.length + ' 关 / ' + taps + ' 次点击');
}

// 撤销上一关（可多次撤销，回退到任意关重新录）
function undoLevel() {
  if (!auto.recording || !auto.script) { setStatus('当前未在录制'); return; }
  if (auto.script.levels.length > 1) {
    auto.script.levels.pop();
    const n = auto.script.levels.length;
    auto.lastTapTime = Date.now();
    setStatus('已撤销到第 ' + n + ' 关，现在重新录这关');
  } else {
    auto.script.levels[0].taps = [];
    auto.lastTapTime = Date.now();
    setStatus('已清空第 1 关点击，重新录');
  }
}

function readScript(gameId) {
  const file = path.join(SCRIPTS_DIR, gameId + '.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function saveScript(gameId, script) {
  const file = path.join(SCRIPTS_DIR, gameId + '.json');
  // 保存前自动备份旧版本，防止误覆盖辛苦录的脚本
  if (fs.existsSync(file)) {
    const bak = path.join(SCRIPTS_DIR, gameId + '.bak.json');
    try { fs.copyFileSync(file, bak); } catch (e) {}
  }
  fs.writeFileSync(file, JSON.stringify(script, null, 2), 'utf8');
}

// 关卡列表：录制中读内存（实时），否则读文件
function getLevelInfo() {
  const s = auto.recording && auto.script ? auto.script : readScript(auto.gameId);
  return s ? s.levels.map(l => ({ name: l.name, taps: l.taps.length })) : null;
}
// 面板要的数据：关卡列表 + 是否录制中 + 当前正在录第几关 + 测试高亮关
function buildLevelData() {
  return {
    levels: getLevelInfo(),
    recording: !!auto.recording,
    current: auto.recording && auto.script ? auto.script.levels.length : 0,
    highlight: auto.highlight
  };
}
// 实时把最新关卡数据推给面板
function sendLevels() {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('levels', buildLevelData());
  }
}

// 重置本次录制
function clearRecording() {
  if (!auto.recording || !auto.script) { setStatus('当前未在录制'); return; }
  auto.script.levels = [{ name: 'L1', taps: [] }];
  auto.lastTapTime = Date.now();
  setStatus('已重置本次录制，从第 1 关开始');
}

// ---------- 自动标记关卡 ----------
// 思路：过关 = 画面变化后重新稳定，且稳定后的画面与上一次"稳定画面"差异足够大（整盘换新）。
// 同一关内的点击/动画只是短暂变化，稳定后仍与上帧相近，不会误判为新关。
const AUTO_MARK_STABLE = 0.82;   // 与上一帧相似 ≥ 此值视为画面已稳定
const AUTO_MARK_SWITCH = 0.72;   // 稳定画面与上一次稳定画面相似 < 此值视为换了新关卡
let markTimer = null;
let stableBaseline = null;       // 最近一次稳定的画面
let prevFrame = null;            // 上一帧
let markTickBusy = false;

async function autoMarkTick() {
  if (markTickBusy) return;
  markTickBusy = true;
  try {
    if (!auto.recording || !auto.options.autoMark) return;
    const cur = await signature();
    if (!cur) return;
    if (!prevFrame) { prevFrame = cur; stableBaseline = cur; return; }
    const vsPrev = similarity(cur, prevFrame);
    if (vsPrev >= AUTO_MARK_STABLE) {
      // 画面已稳定下来
      if (stableBaseline && similarity(cur, stableBaseline) < AUTO_MARK_SWITCH) {
        markLevel(); // 稳定画面与之前那次差异大 = 整盘换新，是新关卡
      }
      stableBaseline = cur;
    }
    prevFrame = cur;
  } finally {
    markTickBusy = false;
  }
}
function startAutoMark() {
  stopAutoMark();
  stableBaseline = null;
  prevFrame = null;
  markTimer = setInterval(() => { autoMarkTick(); }, 600);
}
function stopAutoMark() {
  if (markTimer) clearInterval(markTimer);
  markTimer = null;
  stableBaseline = null;
  prevFrame = null;
}

// ---------- 回放 ----------
async function startPlayback(startIdx = 1) {
  if (auto.playing) return;
  const file = path.join(SCRIPTS_DIR, auto.gameId + '.json');
  if (!fs.existsSync(file)) { setStatus('还没有该游戏的脚本，请先录制'); return; }
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (startIdx < 1) startIdx = 1;
  if (startIdx > script.levels.length) startIdx = script.levels.length;
  auto.playing = true;
  auto.abort = false;
  if (gameWin && !gameWin.isDestroyed()) gameWin.focus();
  // 指定从第 N 关开始时，先自动推进到该关
  if (startIdx > 1) {
    setStatus('正在推进到第 ' + startIdx + ' 关…');
    await runLevels(script, 0, startIdx - 1, '推进到第');
    if (auto.abort) { auto.playing = false; setStatus('已停止'); return; }
  }
  setStatus('自动玩从第 ' + startIdx + ' 关开始');
  let li = startIdx - 1;
  while (auto.playing && !auto.abort) {
    const level = script.levels[li];
    if (level && level.taps.length) {
      setStatus('自动玩 第 ' + (li + 1) + ' 关');
      for (const t of level.taps) {
        if (auto.abort) break;
        await sleep(Math.max(0, t.delay) / auto.options.speed);
        await doTap(t.x, t.y);
      }
      await waitForChange(auto.options.threshold, 8000);
    }
    li++;
    if (li >= script.levels.length) {
      if (auto.options.loop) { li = startIdx - 1; await sleep(1000); }
      else break;
    }
  }
  auto.playing = false;
  setStatus(auto.abort ? '已停止' : '回放结束');
}

// 回放脚本前 count 关，用于"重录某关"时推进游戏到目标关
async function replayPrefix(script, count, onDone) {
  auto.playing = true;
  auto.abort = false;
  if (gameWin && !gameWin.isDestroyed()) gameWin.focus();
  for (let li = 0; li < count && li < script.levels.length; li++) {
    const level = script.levels[li];
    if (level && level.taps.length) {
      setStatus('推进到第 ' + (li + 1) + ' 关…');
      for (const t of level.taps) {
        if (auto.abort) break;
        await sleep(Math.max(0, t.delay) / auto.options.speed);
        await doTap(t.x, t.y);
      }
      await waitForChange(auto.options.threshold, 8000);
    }
  }
  auto.playing = false;
  if (!auto.abort && onDone) onDone();
}

// 播放脚本 levels[from..to-1]（通用：推进、测试、重录前置都用）
async function runLevels(script, from, to, label, onLevel) {
  if (auto.abort) return; // 已被停止则不再继续
  auto.playing = true;
  if (gameWin && !gameWin.isDestroyed()) gameWin.focus();
  for (let li = from; li < to && li < script.levels.length; li++) {
    const lv = script.levels[li];
    if (onLevel) onLevel(li + 1); // 通知当前处理到第几关（用于面板高亮）
    if (lv && lv.taps.length) {
      if (label) setStatus(label + ' 第 ' + (li + 1) + ' 关');
      for (const t of lv.taps) {
        if (auto.abort) break;
        await sleep(Math.max(0, t.delay) / auto.options.speed);
        await doTap(t.x, t.y);
      }
      await waitForChange(auto.options.threshold, 8000);
    }
  }
  auto.playing = false;
}

// 测试某一关：先自动推进到该关，再只播这一关，并提示是否过关
function testLevelAt(idx) {
  const script = readScript(auto.gameId);
  if (!script) { setStatus('没有脚本'); return; }
  if (idx >= script.levels.length) {
    dialog.showMessageBox({
      type: 'warning',
      message: '该关不存在',
      detail: '当前脚本只有 ' + script.levels.length + ' 关（' + script.levels.map(l => l.name).join('、') + '）。请先录制到第 ' + (idx + 1) + ' 关再测试。'
    });
    return;
  }
  if (auto.playing || auto.recording) { setStatus('请先停止录制/回放再测试'); return; }
  auto.abort = false; // 清除上次停止留下的标志，测试是新的主动动作
  const hl = (n) => { auto.highlight = n; sendLevels(); };
  hl(idx + 1);
  setStatus('开始测试第 ' + (idx + 1) + ' 关（先推进到该关）…');
  runLevels(script, 0, idx, '推进到第', hl).then(async () => {
    if (auto.abort) return;
    await runLevels(script, idx, idx + 1, '正在测试第', hl);
    if (auto.abort) return;
    const changed = await waitForChange(auto.options.threshold, 8000);
    auto.highlight = 0;
    sendLevels();
    setStatus(changed
      ? '第 ' + (idx + 1) + ' 关测试完成，画面有变化（预计已过关）'
      : '第 ' + (idx + 1) + ' 关测试完成，但画面未切换（可能没过关）');
  });
}

// 从第 N 关开始重录：自动推进到该关后进入录制（覆盖该关及之后）
function reRecordAt(idx) {
  const script = readScript(auto.gameId);
  if (!script) { setStatus('没有可重录的脚本'); return; }
  if (idx === 0) { startRecording(); return; } // 重头录
  if (idx >= script.levels.length) {
    dialog.showMessageBox({
      type: 'warning',
      message: '该关不存在',
      detail: '当前脚本只有 ' + script.levels.length + ' 关。请先录制到这一关再重录。'
    });
    return;
  }
  // 清掉 idx 及之后，第 idx 关置空
  script.levels = script.levels.slice(0, idx + 1);
  script.levels[idx].taps = [];
  saveScript(auto.gameId, script);
  setStatus('先自动推进到第 ' + idx + ' 关…');
  replayPrefix(script, idx, () => {
    auto.recording = true;
    auto.lastTapTime = Date.now();
    if (auto.options.autoMark) startAutoMark();
    setStatus('已到达第 ' + (idx + 1) + ' 关，开始重录（覆盖原第 ' + (idx + 1) + ' 关）');
  });
}

// 删除某一关
function deleteLevelAt(idx) {
  const script = readScript(auto.gameId);
  if (!script || !script.levels[idx]) { setStatus('该关不存在'); return; }
  script.levels.splice(idx, 1);
  if (!script.levels.length) script.levels.push({ name: 'L1', taps: [] });
  saveScript(auto.gameId, script);
  setStatus('已删除第 ' + (idx + 1) + ' 关并保存');
}
function stopPlayback() {
  auto.abort = true; // 无条件中止，回放/测试/推进都会被中断
  auto.playing = false;
  if (auto.highlight) { auto.highlight = 0; sendLevels(); }
  setStatus('已停止');
}

// ---------- IPC ----------
ipcMain.handle('games:list', () => readGames());
ipcMain.handle('games:add', (e, g) => {
  const list = readGames();
  g.id = g.id || ('g' + Date.now());
  g.mine = true; // 手动添加的游戏
  list.push(g);
  writeGames(list);
  return list;
});
ipcMain.handle('games:update', (e, id, patch) => {
  const list = readGames();
  const g = list.find(x => x.id === id);
  if (!g) return list;
  Object.assign(g, patch);
  writeGames(list);
  return list;
});
ipcMain.handle('games:delete', (e, id) => {
  const list = readGames().filter(x => x.id !== id);
  writeGames(list);
  return list;
});
ipcMain.handle('game:start', (e, id) => {
  const g = readGames().find(x => x.id === id);
  if (g) startGame(g);
  return !!g;
});

// 游戏窗口静音开关（直播时不想让观众听到游戏原声，可一键静音；传 boolean=设定，不传=切换）
ipcMain.handle('game:mute', (e, muted) => {
  if (!gameWin || gameWin.isDestroyed()) return false;
  if (typeof muted === 'boolean') gameWin.webContents.setAudioMuted(muted);
  else gameWin.webContents.setAudioMuted(!gameWin.webContents.isAudioMuted());
  return !!gameWin.webContents.isAudioMuted();
});

// ---------- AI 控制：自然语言 → 点击计划 → 循环执行 ----------
const aiCtl = { playing: false, abort: false, plan: null };
// AI 共享配置：主窗口「AI读弹幕答疑」智谱卡片填写的 Key/Base/Model，控制台 AI 控制直接复用
let aiSharedCfg = { key: '', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash', visionModel: 'glm-4.6v-flash' };
ipcMain.handle('aiCfg:set', (e, cfg) => {
  if (!cfg) return aiSharedCfg;
  if (typeof cfg.key === 'string') aiSharedCfg.key = cfg.key.trim();
  if (typeof cfg.base === 'string' && cfg.base.trim()) aiSharedCfg.base = cfg.base.trim();
  if (typeof cfg.model === 'string' && cfg.model.trim()) aiSharedCfg.model = cfg.model.trim();
  if (typeof cfg.visionModel === 'string' && cfg.visionModel.trim()) aiSharedCfg.visionModel = cfg.visionModel.trim();
  return aiSharedCfg;
});
ipcMain.handle('aiCfg:get', () => aiSharedCfg);

// ---------- 客户端统一配置文件（config/client-config.json） ----------
// 所有模块配置集中存到一个 JSON 文件：启动读取、变更即写、任何模块直接查 JSON
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'client-config.json');
const DEFAULT_CONFIG = {
  version: 1,
  aiChat: {
    provider: 'zhipu',
    dskKey: '', dskBase: 'https://api.deepseek.com', dskModel: 'deepseek-v4-flash',
    zhipuKey: '', zhipuBase: 'https://open.bigmodel.cn/api/paas/v4', zhipuModel: 'glm-4.7-flash',
    siliconKey: '', siliconBase: '', siliconModel: '',
    sensenovaKey: '', sensenovaBase: 'https://token.sensenova.cn/v1', sensenovaModel: 'sensenova-6.7-flash-lite',
    visionModel: 'glm-4.6v-flash',
    aiPrompt: '我是一个小游戏主播，我现在玩的游戏是我要动个脑，如果有用户问玩的什么游戏，请替我回答，只回答用户的提问，其他弹幕不用回答，如果用户问什么游戏，用不同的风格去回复用户，字数在15个字左右',
    aiFilter: '', aiCool: '', aiRetry: '', aiFallback: true, aiFallOrder: '',
    aiOn: false, aiVoice: false, aiText: false
  }
};
let clientConfig = null;
function applyAICfgToShared(){
  const a = (clientConfig && clientConfig.aiChat) || {};
  aiSharedCfg.key = String(a.zhipuKey || '').trim();
  aiSharedCfg.base = String(a.zhipuBase || '').trim() || 'https://open.bigmodel.cn/api/paas/v4';
  aiSharedCfg.model = String(a.zhipuModel || '').trim() || 'glm-4.7-flash';
  aiSharedCfg.visionModel = String(a.visionModel || '').trim() || 'glm-4.6v-flash';
}
function loadClientConfig(){
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      clientConfig = { version: 1, aiChat: Object.assign({}, DEFAULT_CONFIG.aiChat, (raw.aiChat || {})) };
    } else {
      clientConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(clientConfig, null, 2), 'utf8'); } catch (e) {}
    }
  } catch (e) {
    clientConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  applyAICfgToShared();
  return clientConfig;
}
function saveClientConfig(patch){
  if (!clientConfig) clientConfig = loadClientConfig();
  if (patch && typeof patch === 'object') {
    for (const k of Object.keys(patch)) {
      if (k === 'version') continue;
      if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) clientConfig[k] = Object.assign({}, clientConfig[k] || {}, patch[k]);
      else clientConfig[k] = patch[k];
    }
  }
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(clientConfig, null, 2), 'utf8');
  } catch (e) {}
  applyAICfgToShared();
  return clientConfig;
}
loadClientConfig(); // 客户端启动即加载
ipcMain.handle('cfg:load', () => loadClientConfig());
ipcMain.handle('cfg:save', (e, patch) => saveClientConfig(patch));
// 从 LLM 回复中提取 JSON（容忍 ```json 包裹与前后多余文字）
function extractJson(s) {
  if (!s) return null;
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) {
    try { return JSON.parse(String(s).replace(/```json|```/gi, '').trim()); } catch (e2) { return null; }
  }
}
// 调智谱 GLM 生成点击计划 JSON
ipcMain.handle('aiCtl:plan', async (e, cfg) => {
  const apiKey = String(cfg && cfg.apiKey || '').trim() || aiSharedCfg.key; // 未传 Key 时复用主窗口智谱配置
  const text = String(cfg && cfg.text || '').trim();
  const model = String(cfg && cfg.model || '').trim() || aiSharedCfg.model;
  const baseUrl = String(cfg && cfg.baseUrl || '').trim() || aiSharedCfg.base;
  if (!apiKey) return { ok: false, error: '请先在主窗口「AI读弹幕答疑」里填写智谱 API Key' };
  if (!text) return { ok: false, error: '指令为空' };
  const sys = '你是H5小游戏自动点击规划器。游戏窗口尺寸 ' + GAME_W + 'x' + GAME_H + '（相对坐标，左上角为0,0）。根据用户指令只输出一个JSON对象：{"points":[{"x":0~' + GAME_W + '的整数,"y":0~' + GAME_H + '的整数,"times":整数点几次}],"intervalMs":点击间隔毫秒(800~1500),"durationSec":0或秒数(0=一直点直到停止),"checkAfter":每次点击多少轮后检测一次画面(0=不需要检测画面,10~20常用),"note":"一句话说明在做什么"}。多目标点就放多个points。checkAfter按需判断：指令要求观察画面/过关/自适应时设10~20，纯固定点击(如一直点某处)设0。禁止输出JSON以外的任何文字。';
  try {
    const r = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        messages: [ { role: 'system', content: sys }, { role: 'user', content: text } ],
        max_tokens: 400, temperature: 0.3,
        thinking: { type: 'disabled' }
      })
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
    const content = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const plan = extractJson(content);
    if (!plan || !Array.isArray(plan.points) || !plan.points.length) return { ok: false, error: 'AI 未生成有效点击计划' };
    plan.points = plan.points.map(p => ({ x: Math.max(0, Math.min(GAME_W, Math.round(Number(p.x) || 0))), y: Math.max(0, Math.min(GAME_H, Math.round(Number(p.y) || 0))), times: Math.max(1, Math.round(Number(p.times) || 1)) }));
    plan.intervalMs = Math.max(200, Math.round(Number(plan.intervalMs) || 1000));
    plan.durationSec = Math.max(0, Number(plan.durationSec) || 0);
    plan.checkAfter = Math.max(0, Math.min(100, Math.round(Number(plan.checkAfter) || 0))); // 0=不检测，>0=每N轮点击检测一次
    plan.note = String(plan.note || '');
    return { ok: true, plan };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
// 视觉检查：截当前游戏画面给 GLM 视觉模型，返回下一步决策（失败自动重试最多3次）
async function aiVisionCheck(plan, userText) {
  const MAX_RETRY = 3, RETRY_DELAY = 2000;
  let last = null;
  for (let i = 1; i <= MAX_RETRY; i++) {
    last = await aiVisionCheckOnce(plan, userText);
    if (last.ok || last.fatal) return last; // 成功或不可重试（窗口没了）直接返回
    if (i < MAX_RETRY) { setStatus('视觉检查失败（' + last.error + '），重试中 ' + i + '/' + MAX_RETRY + '…'); await sleep(RETRY_DELAY); }
  }
  last.error = (last.error || '未知错误') + '（已重试 ' + MAX_RETRY + ' 次仍失败）';
  return last;
}
async function aiVisionCheckOnce(plan, userText) {
  try {
    if (!gameWin || gameWin.isDestroyed()) return { ok: false, fatal: true, error: '游戏窗口不存在' };
    const img = await gameWin.webContents.capturePage();
    const b64 = img.toJPEG(70).toString('base64'); // JPEG 压缩，减小请求体积
    const sys = '你是H5小游戏视觉操作员。画面是游戏窗口（相对坐标 ' + GAME_W + 'x' + GAME_H + '，左上角为0,0）。玩家的目标指令：' + (userText || '') + '。当前点击计划：' + JSON.stringify({ points: plan.points, intervalMs: plan.intervalMs }) + '。看画面判断下一步，只输出一个JSON：{"act":"continue|adjust|stop|wait","points":[{"x":0~' + GAME_W + ',"y":0~' + GAME_H + ',"times":n}],"intervalMs":800~1500,"note":"你看到的画面状态一句话"}。continue=画面正常按原计划继续；adjust=画面变化，按新的points点；stop=已通关/失败/画面结束；wait=画面正在变化先等待。act为continue或wait时points可为空。禁止输出JSON以外的任何文字。';
    const r = await fetch(aiSharedCfg.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiSharedCfg.key },
      body: JSON.stringify({
        model: aiSharedCfg.visionModel || 'glm-4.6v-flash',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: [ { type: 'text', text: '请判断当前游戏画面状态并给出下一步' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } } ] }
        ],
        max_tokens: 400, temperature: 0.3,
        thinking: { type: 'disabled' }
      })
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
    const content = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const d = extractJson(content);
    if (!d || !d.act) return { ok: false, error: '视觉模型未返回有效决策' };
    const res = { ok: true, act: d.act, note: String(d.note || ''), intervalMs: Math.max(200, Math.round(Number(d.intervalMs) || 1000)) };
    if (Array.isArray(d.points) && d.points.length) {
      res.points = d.points.map(p => ({ x: Math.max(0, Math.min(GAME_W, Math.round(Number(p.x) || 0))), y: Math.max(0, Math.min(GAME_H, Math.round(Number(p.y) || 0))), times: Math.max(1, Math.round(Number(p.times) || 1)) }));
    }
    return res;
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}
// 按计划循环点击（视觉反馈：按 AI 规划出的 checkAfter 节奏检测画面，0=不检测，3秒内不重复）
async function aiRunLoop(plan, userText, visionOn) {
  const cur = { points: plan.points.slice(), intervalMs: plan.intervalMs, note: plan.note, checkAfter: plan.checkAfter || 0 };
  const maxMs = plan.durationSec > 0 ? plan.durationSec * 1000 : Infinity;
  const t0 = Date.now();
  let pi = 0;
  let clickSinceVision = 0; // 距上次视觉检查的点击轮数
  let lastVision = 0;       // 上次视觉检查时间戳
  if (gameWin && !gameWin.isDestroyed()) gameWin.focus();
  while (aiCtl.playing && !aiCtl.abort) {
    const now = Date.now();
    // 按 AI 规划节奏检测：达到 checkAfter 轮 且 距上次≥3秒（节流防 API 轰炸）
    const dueByClicks = cur.checkAfter > 0 && clickSinceVision >= cur.checkAfter;
    const throttled = lastVision > 0 && (now - lastVision < 3000);
    if (visionOn && aiSharedCfg.key && dueByClicks && !throttled) {
      lastVision = now;
      clickSinceVision = 0;
      const v = await aiVisionCheck(cur, userText);
      if (v) {
        if (v.ok && v.act === 'stop') { setStatus('AI 看到：' + (v.note || '画面结束') + ' → 停止'); aiCtl.playing = false; break; }
        else if (v.ok && v.act === 'adjust' && v.points && v.points.length) { cur.points = v.points; cur.intervalMs = v.intervalMs; if (v.note) setStatus('AI 看到：' + v.note + ' → 调整点击位置'); }
        else if (v.ok && v.act === 'continue') { if (v.note) setStatus('AI 看到：' + v.note + ' → 继续'); }
        else if (v.ok && v.act === 'wait') { await sleep(v.intervalMs || 1500); lastVision = 0; continue; } // 画面在动，等待后重新检查，本轮不点击
        else if (!v.ok) setStatus('视觉检查失败（' + v.error + '），按原计划继续'); // 视觉 API 异常 → 降级盲点，不中断
      }
    }
    const p = cur.points[pi % cur.points.length];
    for (let k = 0; k < p.times; k++) {
      if (aiCtl.abort) break;
      await doTap(p.x, p.y);
      await sleep(cur.intervalMs);
    }
    pi++;
    clickSinceVision++; // 完成一轮点击后计数
    if (Date.now() - t0 > maxMs) break;
  }
  aiCtl.playing = false;
  setStatus(aiCtl.abort ? 'AI 控制已停止' : 'AI 控制结束：' + (cur.note || plan.note));
}
ipcMain.on('aiCtl:start', (e, data) => {
  const plan = data && data.plan;
  if (aiCtl.playing) { setStatus('AI 控制已在运行，先停止再换指令'); return; }
  if (!plan || !Array.isArray(plan.points) || !plan.points.length) { setStatus('无效点击计划'); return; }
  aiCtl.plan = plan;
  aiCtl.userText = String(data.text || '');
  aiCtl.visionOn = !!data.visionOn;
  aiCtl.playing = true;
  aiCtl.abort = false;
  const vDesc = aiCtl.visionOn ? (plan.checkAfter > 0 ? '（视觉反馈：每' + plan.checkAfter + '次点击检测画面）' : '（视觉反馈开启，按 AI 计划检测）') : '';
  setStatus('AI 控制开始' + vDesc + '：' + plan.note);
  aiRunLoop(plan, aiCtl.userText, aiCtl.visionOn);
});
ipcMain.on('aiCtl:stop', () => { if (aiCtl.playing) { aiCtl.abort = true; setStatus('正在停止 AI 控制…'); } });
ipcMain.handle('aiCtl:state', () => ({ playing: aiCtl.playing, note: (aiCtl.plan && aiCtl.plan.note) || '' }));

ipcMain.on('game:pointer', (e, p) => {
  if (auto.recording && auto.script) {
    const now = Date.now();
    const level = auto.script.levels[auto.script.levels.length - 1];
    level.taps.push({ x: Math.round(p.x), y: Math.round(p.y), delay: now - auto.lastTapTime });
    auto.lastTapTime = now;
    sendLevels(); // 每次点击实时刷新关卡计数
  }
});

ipcMain.on('rec:start', () => { startRecording(); sendLevels(); });
ipcMain.on('rec:mark', () => { markLevel(); sendLevels(); });
ipcMain.on('rec:stop', () => { stopRecording(); sendLevels(); });
ipcMain.on('rec:undo', () => { undoLevel(); sendLevels(); });
ipcMain.on('rec:clear', () => { clearRecording(); sendLevels(); });
ipcMain.handle('script:info', () => buildLevelData());
ipcMain.on('script:reRecord', (e, idx) => { reRecordAt(idx); sendLevels(); });
ipcMain.on('script:deleteLevel', (e, idx) => { deleteLevelAt(idx); sendLevels(); });
ipcMain.on('script:test', (e, idx) => testLevelAt(idx));
ipcMain.on('play:start', (e, startIdx) => startPlayback(startIdx || 1));
ipcMain.on('play:stop', stopPlayback);
ipcMain.handle('option:get', () => Object.assign({}, auto.options)); // 面板打开时按当前游戏加载
ipcMain.on('option:set', (e, patch) => {
  auto.options = Object.assign(auto.options, patch);
  if ('autoMark' in patch) {
    if (auto.recording) { if (patch.autoMark) startAutoMark(); else stopAutoMark(); }
  }
  saveGameOptions(); // 变更即写入当前游戏的独立配置
});
ipcMain.on('tpl:capture', async () => {
  if (!gameWin || gameWin.isDestroyed()) return;
  const img = await gameWin.webContents.capturePage();
  const file = path.join(TPL_DIR, auto.gameId + '-' + Date.now() + '.png');
  fs.writeFileSync(file, img.toPNG());
  setStatus('已截图模板：' + path.basename(file));
});

// ---------- 弹幕自动回复（非官方：浏览器自动化抓直播间 DOM） ----------
let danmakuWin = null;
let dmTimer = null;
const DM_INTERVAL = 600;

// 注入到直播间页：MutationObserver 只抓聊天容器(.webcast-chatroom)里的消息 item(.webcast-chatroom___item)。
// 结构：div.webcast-chatroom(唯一容器) > div[data-index=N](消息父节点带递增序号) > div.webcast-chatroom___item(消息)。
// 用 item 父节点的 data-index 去重（只处理比已处理最大序号大的），不多抓任何多余内容。
// 传输 {t: 文本, type: 'chat'(聊天) | 'event'(事件消息,含 bottom_message)}。
const dmInject = `(function(){
  if (window.__dmObsInjected) return 'already';
  window.__dmNew = window.__dmNew || [];
  var lastIdx = -1; // 已处理的最大 data-index，防止同一消息被多次抓取
  function clean(t){ return (t||'').replace(/\\s+/g,' ').trim(); }
  // 消息类型：item 含 bottom_message → 事件消息('event')，否则聊天('chat')
  function msgType(el){
    if (!el) return 'chat';
    var c = String(el.className||'');
    if (/bottom_message/.test(c)) return 'event';
    if (el.querySelectorAll) {
      try { var m = el.querySelectorAll('[class*="bottom_message"]'); if (m && m.length) return 'event'; } catch(e){}
    }
    return 'chat';
  }
  // 只抓一条消息 item：data-index 在它的父节点上，用它去重
  function pushItem(item){
    if (!item || item.nodeType !== 1) return;
    var p = item.parentElement;
    var idxAttr = p && p.getAttribute ? p.getAttribute('data-index') : null;
    var idx = idxAttr != null ? parseInt(idxAttr, 10) : NaN;
    if (idx != null && !isNaN(idx)) {
      if (idx <= lastIdx) return; // 已处理过，跳过
      lastIdx = idx;
    }
    const txt = clean(item.innerText);
    if (!txt || txt.length > 120) return;   // 只挡空文本与超长文本
    window.__dmNew.push({ t: txt, type: msgType(item) });
  }
  // 处理新增节点：只处理它内部(或自身)的聊天 item，不多抓
  function scanNode(node){
    if (!node || node.nodeType !== 1) return;
    var items;
    try { items = node.querySelectorAll ? node.querySelectorAll('.webcast-chatroom___item') : []; } catch(e){ items = []; }
    if (items && items.length) {
      for (var i = 0; i < items.length; i++) pushItem(items[i]);
      return;
    }
    if (node.classList && node.classList.contains('webcast-chatroom___item')) { pushItem(node); return; }
    // 兜底：如果新增节点带 data-index 且内部有 item，只处理 item 层
  }
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) scanNode(n);
      if (m.type === 'characterData' && m.target && m.target.parentElement) scanNode(m.target.parentElement);
    }
  });
  try { obs.observe(document.body, {childList:true, subtree:true, characterData:true}); } catch(e){}
  window.__dmObsInjected = true;
  return 'started';
})()`;
const dmPull = `(()=>{ var a=(window.__dmNew||[]).slice(); window.__dmNew=[]; return a; })()`;


let lastDmStatus = ''; // 去重：连续相同状态只发一次（避免 did-start-loading 重复刷屏）
function sendDmStatus(msg) { if (msg === lastDmStatus) return; lastDmStatus = msg; if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send('dm:status', msg); }

function connectDanmaku(url) {
  disconnectDanmaku();
  if (!/^https?:\/\//.test(url)) return;
  sendDmStatus('正在打开直播间页面…');
  danmakuWin = new BrowserWindow({
    width: 1080, height: 760, show: false,
    backgroundColor: '#0f1020', title: '弹幕源（直播间）',
    webPreferences: { contextIsolation: true, nodeIntegration: false, partition: 'persist:douyin' }
  });
  danmakuWin.setMenuBarVisibility(false);
  danmakuWin.webContents.setAudioMuted(true); // 连接直播间后直接静音，防止后台弹幕源窗口出声干扰
  let loadFailed = false;
  danmakuWin.webContents.on('did-start-loading', () => sendDmStatus('正在加载直播间页面…'));
  danmakuWin.webContents.on('did-fail-load', (_e, code, desc) => { loadFailed = true; sendDmStatus('页面加载失败：' + desc + '（code ' + code + '）'); });
  danmakuWin.webContents.on('did-finish-load', async () => {
    if (loadFailed) { sendDmStatus('已停止：直播间页面加载失败'); return; }
    sendDmStatus('页面加载完成，注入弹幕监听…');
    danmakuWin.webContents.setAudioMuted(true); // 页面加载完成后再次确保静音（防止页面重置音频状态）
    const r = await danmakuWin.webContents.executeJavaScript(dmInject, true).catch(() => 'error');
    sendDmStatus('弹幕监听已注入（' + r + '），开始实时抓取…');
    startDanmaku();
  });
  // 加载超时兜底：超过 20 秒仍无弹幕数据且页面未完成，提示可能未进入直播间
  const loadTimeout = setTimeout(() => { sendDmStatus('提示：页面加载较慢或未进入直播间，请确认链接是否有效'); }, 20000);
  danmakuWin.webContents.once('did-finish-load', () => clearTimeout(loadTimeout));
  danmakuWin.loadURL(url);
  danmakuWin.on('closed', () => { danmakuWin = null; stopDanmaku(); });
}
function startDanmaku() {
  stopDanmaku();
  dmTimer = setInterval(async () => {
    if (!danmakuWin || danmakuWin.isDestroyed()) return;
    try {
      const arr = await danmakuWin.webContents.executeJavaScript(dmPull, true);
      if (arr && arr.length) {
        const seen = new Set();
        const uniq = arr.filter(x => { const k = (x && x.t) || ''; if (!k || seen.has(k)) return false; seen.add(k); return true; }); // 按文本兜底去重
        if (uniq.length && libraryWin && !libraryWin.isDestroyed()) {
          uniq.forEach(line => libraryWin.webContents.send('dm:message', line));
        }
      }
    } catch (e) {}
  }, DM_INTERVAL);
}
function stopDanmaku() { if (dmTimer) { clearInterval(dmTimer); dmTimer = null; } }
function disconnectDanmaku() { stopDanmaku(); if (danmakuWin && !danmakuWin.isDestroyed()) danmakuWin.destroy(); danmakuWin = null; }

ipcMain.handle('dm:connect', (e, url) => { connectDanmaku(String(url || '').trim()); return true; });
ipcMain.handle('dm:showLogin', () => { if (danmakuWin && !danmakuWin.isDestroyed()) { danmakuWin.show(); danmakuWin.focus(); } return true; });
ipcMain.handle('dm:hide', () => { if (danmakuWin && !danmakuWin.isDestroyed()) danmakuWin.hide(); return true; });
ipcMain.handle('dm:disconnect', () => { disconnectDanmaku(); return true; });
ipcMain.handle('dm:filterRule', () => { createFilterRule(); return true; });
ipcMain.handle('deviceGuide:open', () => { createDeviceGuide(); return true; });
ipcMain.handle('deviceDir:open', async () => {
  const dir = path.join(DATA_DIR, 'software');
  if (!fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) {} }
  const err = await shell.openPath(dir);
  return err || true;
});
// 语音队列：打开窗口 + 同步队列快照（library 渲染进程 → 主进程 → voiceQueue 窗口）
ipcMain.handle('voiceQueue:open', () => { createVoiceQueue(); return true; });
ipcMain.handle('voiceQueue:sync', (_e, data) => {
  voiceQueueData = data || null;
  if (voiceQueueWin && !voiceQueueWin.isDestroyed()) voiceQueueWin.webContents.send('voiceQueue:data', voiceQueueData);
  return true;
});
// 语音队列窗口点击「清空语音」→ 通知主窗口渲染进程执行 stopAllVoice
ipcMain.handle('voiceQueue:clear', () => {
  if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send('voiceQueue:clear');
  return true;
});
// 语音队列窗口点击「暂停/继续」→ 通知主窗口渲染进程执行 pauseVoice/resumeVoice
ipcMain.handle('voiceQueue:pause', (_e, paused) => {
  if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send('voiceQueue:pause', paused);
  return true;
});
// 截取当前主屏幕画面（供 AI 视觉答疑：GLM-4.6V-Flash 看直播画面回答问题）
ipcMain.handle('screen:capture', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    if (!sources || !sources.length) return { ok: false, error: '未找到可用屏幕' };
    return { ok: true, dataUrl: sources[0].thumbnail.toDataURL() }; // 主显示器
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('ai:chat', async (_e, cfg) => {
  try {
    const apiKey = String(cfg && cfg.apiKey || '').trim();
    const baseUrl = String(cfg && cfg.baseUrl || 'https://api.deepseek.com').trim();
    const model = String(cfg && cfg.model || 'deepseek-chat').trim();
    if (!apiKey) return { ok: false, error: '请先填写 API Key' };
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const isGlm = /^glm/i.test(model);
    const payload = { model, messages: cfg.messages || [], max_tokens: 300, temperature: 0.8 };
    if (isGlm) payload.thinking = { type: 'disabled' }; // 智谱混合思考模型：关闭思考，让 content 直接返回正式回答
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status) };
    const msg = (j && j.choices && j.choices[0] && j.choices[0].message) || {};
    let text = msg.content;
    if (text == null || text === '') text = msg.reasoning_content;
    if (Array.isArray(text)) text = text.map(p => (p && (p.text || p.content)) || '').join('');
    text = String(text || '').trim();
    return { ok: true, text };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// ---------- 启动 ----------
// 保留 Edit 菜单：macOS 上剪切/复制/粘贴/全选快捷键依赖它，删掉会导致输入框无法粘贴
if (process.platform === 'darwin') {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' } // 含 undo/redo/cut/copy/paste/selectAll
  ]));
} else {
  Menu.setApplicationMenu(null);
}
app.whenReady().then(() => {
  createLibrary();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createLibrary(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
