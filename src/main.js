const { app, BrowserWindow, ipcMain, nativeImage, Menu, dialog, shell, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { execFile, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const dmProto = require('./danmaku-proto'); // 抖音 WS 推送帧 protobuf 解码（零依赖）

const ROOT = app.getAppPath();
const DATA_DIR = path.join(ROOT, 'src');
const GAMES_FILE = path.join(ROOT, 'config', 'games.json'); // 游戏库独立配置文件
const AUTOPLAY_FILE = path.join(ROOT, 'config', 'autoplay.json'); // 每个游戏独立的自动玩配置
const VOICES_FILE = path.join(ROOT, 'config', 'voices.json'); // 音色库配置（用户数据）
const SCRIPTS_DIR = path.join(ROOT, 'config', 'scripts'); // 各游戏关卡脚本（用户数据）
const MEDIA_DIR = path.join(ROOT, 'config', 'media'); // 背景音乐素材库
const TPL_DIR = path.join(ROOT, 'templates');

// 参考音频路径统一处理：voices.json 里存相对项目根的路径（整目录可复制），使用时解析成绝对路径
function resolveRef(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) || s.includes('://')) return s;
  return path.join(ROOT, s.split('/').join(path.sep));
}
function toRelRef(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}
function isStoredVoice(p) {
  return resolveRef(p).startsWith(path.join(ROOT, 'config', 'voices'));
}

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
  phase: '', // 当前阶段标记：''=常规 | 'prep'=重录推进（面板显示"推进中"，非"自动玩中"）
  cdpAttached: false,
  script: null,
  lastTapTime: 0,
  abort: false,
  highlight: 0, // 当前正在测试/推进的关（1 基，0=无）
  options: { method: 'cdp', speed: 1, loop: false, threshold: 0.9, autoMark: false, freshStart: false, aiCmd: '', aiTextModel: '', aiVisionModel: '', aiHiRes: false }
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
  // 保留独立于 auto.options 的字段（游戏备注 note、AI 指令模板 aiCmdTemplates/aiCmdActive），
  // 别被差异覆盖冲掉。这些字段由各自的 IPC 单独维护，不进 auto.options 差异计算。
  const EXTRA_KEYS = ['note', 'aiCmdTemplates', 'aiCmdActive'];
  const prev = map[auto.gameId];
  const extras = {};
  let hasExtra = false;
  if (prev) for (const k of EXTRA_KEYS) {
    if (prev[k] !== undefined) { extras[k] = prev[k]; hasExtra = true; }
  }
  if (hasDiff) {
    map[auto.gameId] = Object.assign(diff, extras);
  } else {
    if (hasExtra) map[auto.gameId] = extras;
    else delete map[auto.gameId];
  }
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
  // 复制到 config/voices 目录，避免原始文件被移动/删除导致失效；存相对路径便于整体迁移
  const voicesDir = path.join(ROOT, 'config', 'voices');
  try { fs.mkdirSync(voicesDir, { recursive: true }); } catch (e) {}
  let storedPath = refAudio;
  try {
    const ext = path.extname(refAudio) || '.wav';
    const dest = path.join(voicesDir, `voice_${Date.now()}_${name.replace(/[\\/:*?"<>|]/g, '_')}${ext}`);
    fs.copyFileSync(resolveRef(refAudio), dest);
    storedPath = toRelRef(dest);
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
  if (rec && isStoredVoice(rec.refAudio)) {
    try { fs.unlinkSync(resolveRef(rec.refAudio)); } catch (e) {}
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
      fs.copyFileSync(resolveRef(newAudio), dest);
      storedPath = toRelRef(dest);
    } catch (e) { /* 复制失败则沿用新路径 */ }
    // 若原文件是本库内复制品且被替换，删除旧副本
    if (isStoredVoice(rec.refAudio) && rec.refAudio !== storedPath) {
      try { fs.unlinkSync(resolveRef(rec.refAudio)); } catch (e) {}
    }
    rec.refAudio = storedPath;
  }
  writeVoices(list);
  return { ok: true, voice: rec, list };
});
function setStatus(text, extra = {}) {
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('status', { text, ...extra, phase: auto.phase || '', recording: auto.recording, playing: auto.playing });
  }
}
// 实时思考摘要通道：单独事件，面板只刷新"正在思考"那一行（不追加历史），避免每个 token 刷屏
let lastThinkPush = 0;
let lastThinkText = '';
function pushThinking(text, model) {
  const now = Date.now();
  const t = String(text || '');
  if (now - lastThinkPush < 120 && t.length - lastThinkText.length < 12) return; // 节流：够快就刷，避免卡顿也不刷屏
  lastThinkPush = now;
  lastThinkText = t;
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.webContents.send('ai-thinking', { text: t, model: model || '' });
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
// 合成音频的临时目录：不要写系统 %TEMP%。
// Windows 上常报 "EPERM: operation not permitted, mkdir ...\Temp\aiassist_voice\..."，
// 这通常不是 NTFS 权限问题（ACL 显示可写也一样），而是安全软件 / 受控文件夹访问 /
// 应用沙箱对 %TEMP% 的进程级写入限制。项目其余数据都在 ROOT/config，
// 临时音频也放这里：既保证可写，又保持"整目录可复制"；ROOT 只读时再逐级回退。
function voiceTmpCandidates() {
  const list = [path.join(ROOT, 'config', 'voice-tmp')];
  try { list.push(path.join(app.getPath('userData'), 'aiassist_voice')); } catch (e) {}
  try { list.push(path.join(os.tmpdir(), 'aiassist_voice')); } catch (e) {}
  return list;
}
let VOICE_TMP = null; // 实际选中的临时目录，cleanVoiceTmp 用它
// 启动时探测一次（静默，失败不抛；真正合成时 makeVoiceDir 会再试一遍）
for (const c of voiceTmpCandidates()) {
  try {
    fs.mkdirSync(c, { recursive: true });
    const probe = path.join(c, '.probe_' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    VOICE_TMP = c;
    break;
  } catch (e) {}
}
// 每次合成新建唯一子目录：逐个候选目录试，第一个能建就用。
// 用 mkdtempSync 而非 Date.now()——快速连点时两次合成可能撞名，会写进同一个 tts.wav 串音。
function makeVoiceDir() {
  let lastErr = null;
  for (const c of voiceTmpCandidates()) {
    try {
      fs.mkdirSync(c, { recursive: true });
      const dir = fs.mkdtempSync(path.join(c, 'tts-'));
      VOICE_TMP = c; // 记录实际使用的目录，供 cleanVoiceTmp 清理
      return dir;
    } catch (e) { lastErr = e; }
  }
  throw new Error('所有临时目录都不可写（' + String((lastErr && lastErr.message) || lastErr || '未知错误') + '）');
}
// 清理合成产生的临时音频（每次合成会新建一个子目录，不清理会一直堆积）。
// 规则：按修改时间从新到旧，保留最近 keepRecent 个；超出部分且大于 olderThanMs 的才删除。
function cleanVoiceTmp(opt) {
  const base = VOICE_TMP;
  if (!base) return;
  const keepRecent = (opt && opt.keepRecent != null) ? opt.keepRecent : 500;
  const olderThanMs = (opt && opt.olderThanMs != null) ? opt.olderThanMs : 2 * 60 * 60 * 1000;
  try {
    const names = fs.readdirSync(base);
    const items = [];
    for (const n of names) {
      const p2 = path.join(base, n);
      let mt = 0; try { mt = fs.statSync(p2).mtimeMs; } catch (e) { mt = 0; }
      items.push({ p: p2, mt });
    }
    items.sort((a, b) => b.mt - a.mt); // 新→旧
    const now = Date.now();
    let removed = 0;
    for (let i = 0; i < items.length; i++) {
      if (i < keepRecent) continue;                 // 最近 N 个一律保留（含正在循环播放的）
      if (now - items[i].mt < olderThanMs) continue; // 还没到清理时限的保留
      try { fs.rmSync(items[i].p, { recursive: true, force: true }); removed++; } catch (e) {}
    }
    if (removed) console.log('[voice-tmp] 已清理临时音频 ' + removed + ' 个');
  } catch (e) {}
}
// 启动清理：此时没有任何播放，安全地把历史堆积清掉，只保留最近 50 个
try { cleanVoiceTmp({ keepRecent: 50, olderThanMs: 0 }); } catch (e) {}

// 百度 TTS OAuth token 缓存（有效期 30 天，内存复用）
let baiduToken = null;
let baiduTokenExp = 0;

// 探测可用的 edge-tts Python 解释器（结果缓存）：EDGE_TTS_PYTHON > python3 > python > py -3 > 常见安装路径
// Windows 上 PATH 里的 python3 可能是微软商店版（未装 edge_tts），逐个探测直到找到能跑 edge_tts 的解释器
let edgePyInfo = null; // { cmd, prefix }
function resolveEdgeTtsPython() {
  if (edgePyInfo) return edgePyInfo;
  const env = String(process.env.EDGE_TTS_PYTHON || '').trim();
  const candidates = [];
  if (env) candidates.push({ cmd: env, prefix: [] });
  candidates.push(
    { cmd: 'python3', prefix: [] },
    { cmd: 'python', prefix: [] },
    { cmd: 'py', prefix: ['-3'] },
    { cmd: 'C:\\Python310\\python.exe', prefix: [] },
    { cmd: 'C:\\Python311\\python.exe', prefix: [] },
    { cmd: 'C:\\Python312\\python.exe', prefix: [] },
    { cmd: 'D:\\Python310\\python.exe', prefix: [] },
    { cmd: 'D:\\Python311\\python.exe', prefix: [] },
    { cmd: 'D:\\Python312\\python.exe', prefix: [] },
    { cmd: 'E:\\Python310\\python.exe', prefix: [] },
    { cmd: 'E:\\Python311\\python.exe', prefix: [] },
    { cmd: 'E:\\Python312\\python.exe', prefix: [] }
  );
  for (const c of candidates) {
    try {
      execFileSync(c.cmd, c.prefix.concat(['-m', 'edge_tts', '--help']), { timeout: 8000, windowsHide: true, stdio: 'ignore' });
      edgePyInfo = c;
      return c;
    } catch (e) { /* 该候选不可用，试下一个 */ }
  }
  return null;
}

ipcMain.handle('ai:open', () => createAI());

// 合成语音，返回本地 file:// 音频 URL（edge-tts / 本地 GPT-SoVITS / 阿里云 Qwen3-TTS）
ipcMain.handle('ai:tts', async (e, opts) => {
  const text = String(opts && opts.text || '').trim();
  if (!text) return { ok: false, err: '文案为空' };
  const engine = (opts && opts.engine) || 'edge';
  const speed = Number(opts && opts.speed) || 1; // 0.5 ~ 2.0
  let dir;
  try { dir = makeVoiceDir(); }
  catch (err) {
    return { ok: false, err: '无法创建语音临时目录：' + String((err && err.message) || err) +
      '。请把软件放在有写权限的目录（不要放 Program Files / 只读盘），或检查安全软件/受控文件夹访问是否拦截了本程序。' };
  }
  try {
    try { cleanVoiceTmp(); } catch (e) {} // 运行中轻量清理（默认只删>2h且超过500个的旧文件，不误删在用的）

    if (engine === 'sovits') {
      // 本地 GPT-SoVITS 引擎：调用 127.0.0.1:9880
      const refAudio = resolveRef(opts && opts.refAudio);
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

    if (engine === 'qwen3') {
      // 阿里云 Qwen3-TTS：DashScope 百炼非流式合成（返回 OSS 音频 URL → 下载到本地）
      const a = (clientConfig && clientConfig.aiChat) || {};
      const qwenKey = String(opts && opts.apiKey || '').trim() || String(a.qwenKey || '').trim();
      if (!qwenKey) return { ok: false, err: '请先在 AI 主播页「阿里云 Qwen3-TTS」填写 API Key' };
      const qwenModel = String(opts && opts.model || '').trim() || String(a.qwenModel || '').trim() || 'qwen3-tts-flash';
      const voice = String(opts && opts.voice || '').trim() || 'Cherry';
      const apiUrl = String(opts && opts.baseUrl || '').trim() || 'https://dashscope.aliyuncs.com/api/v1';
      const r = await fetch(apiUrl.replace(/\/+$/, '') + '/services/aigc/multimodal-generation/generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + qwenKey },
        body: JSON.stringify({ model: qwenModel, input: { text, voice, language_type: 'Chinese' }, parameters: { stream: false } })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) return { ok: false, err: (j && (j.message || j.code)) || ('HTTP ' + r.status) };
      const audioUrl = j && j.output && j.output.audio && j.output.audio.url;
      if (!audioUrl) return { ok: false, err: '合成失败：未返回音频 URL（' + (j && j.message || '未知错误') + '）' };
      const dl = await fetch(audioUrl);
      if (!dl.ok) return { ok: false, err: '下载音频失败 HTTP ' + dl.status };
      const buf = Buffer.from(await dl.arrayBuffer());
      const name = path.basename(new URL(audioUrl).pathname) || 'tts.mp3';
      const outPath = path.join(dir, /\.(mp3|wav|pcm|ogg|m4a)$/i.test(name) ? name : ('tts' + (name.includes('.') ? name.slice(name.lastIndexOf('.')) : '.mp3')));
      fs.writeFileSync(outPath, buf);
      return { ok: true, url: pathToFileURL(outPath).href };
    }

    if (engine === 'baidu') {
      // 百度智能云短文本语音合成：AK/SK 换 OAuth token → tsn.baidu.com/text2audio
      const a = (clientConfig && clientConfig.aiChat) || {};
      const ak = String(opts && opts.apiKey || '').trim() || String(a.baiduAk || '').trim();
      const sk = String(opts && opts.apiSecret || '').trim() || String(a.baiduSk || '').trim();
      if (!ak || !sk) return { ok: false, err: '请先在 AI 主播页「百度智能云 TTS」填写 AK 和 SK' };
      // 取 access_token（内存缓存 30 天内复用，百度 token 有效期 30 天）
      if (!baiduToken || !baiduTokenExp || Date.now() >= baiduTokenExp) {
        const tr = await fetch('https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=' + encodeURIComponent(ak) + '&client_secret=' + encodeURIComponent(sk), { method: 'POST' });
        const tj = await tr.json().catch(() => null);
        if (!tr.ok || !tj || !tj.access_token) return { ok: false, err: '百度获取 token 失败：' + ((tj && (tj.error_description || tj.error)) || ('HTTP ' + tr.status)) };
        baiduToken = tj.access_token;
        baiduTokenExp = Date.now() + (Math.max(60, Number(tj.expires_in) || 2592000) - 60) * 1000;
      }
      const per = String(opts && opts.voice || '').trim() || '0';
      const spd = Math.max(0, Math.min(15, Math.round(5 + (speed - 1) * 10))); // 语速 0~15，默认 5
      const form = new URLSearchParams({
        tex: text, tok: baiduToken, cuid: 'aiplaygame', ctp: '1', lan: 'zh',
        spd: String(spd), pit: '5', vol: '5', per, aue: '3'
      });
      const sr = await fetch('https://tsn.baidu.com/text2audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      const ct = sr.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const ej = await sr.json().catch(() => null);
        return { ok: false, err: '百度合成失败：' + ((ej && (ej.err_msg || ej.err_no)) || ('HTTP ' + sr.status)) };
      }
      if (!sr.ok) return { ok: false, err: '百度合成失败 HTTP ' + sr.status };
      const buf = Buffer.from(await sr.arrayBuffer());
      const outPath = path.join(dir, 'tts.mp3');
      fs.writeFileSync(outPath, buf);
      return { ok: true, url: pathToFileURL(outPath).href };
    }

    // 默认：edge-tts 云端（Python edge-tts 驱动，自动解析微软最新端点；msedge-tts 写死端点已被微软停用返回 200）
    const voice = (opts && opts.voice) || 'zh-CN-XiaoxiaoNeural';
    const ratePct = Math.max(-50, Math.min(100, Math.round((speed - 1) * 100)));
    const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
    const outPath = path.join(dir, 'tts.mp3');
    const txtPath = path.join(dir, 'text.txt');
    fs.writeFileSync(txtPath, text, 'utf8');
    const pyInfo = resolveEdgeTtsPython();
    if (!pyInfo) return { ok: false, err: 'edge-tts 云端合成失败（未找到可用的 Python：请先 pip install -U edge-tts，或设置 EDGE_TTS_PYTHON 指向已安装 edge-tts 的 python，可改用本地 GPT-SoVITS 引擎）' };
    const synthOk = await new Promise((resolve) => {
      execFile(pyInfo.cmd, pyInfo.prefix.concat(['-m', 'edge_tts', '--voice', voice, '--rate=' + rateStr, '--file', txtPath, '--write-media', outPath]),
        { timeout: 60000, windowsHide: true }, (err) => resolve(!err && fs.existsSync(outPath)));
    });
    if (!synthOk) return { ok: false, err: 'edge-tts 云端合成失败（已找到 ' + pyInfo.cmd + ' 但合成出错，可改用本地 GPT-SoVITS 引擎）' };
    return { ok: true, url: pathToFileURL(outPath).href };
  } catch (err) {
    return { ok: false, err: String((err && err.message) || err) };
  }
});

// 调用本地 GPT-SoVITS api_v2.py 的 /tts 接口，合成并保存为 wav
function sovitsTts(text, refAudio, outPath, speed, inferParams) {
  refAudio = resolveRef(refAudio);
  // 参考文本：从音色库按参考音频匹配补全
  let promptText = '';
  try {
    const voices = JSON.parse(fs.readFileSync(VOICES_FILE, 'utf8'));
    const hit = (voices || []).find(v => resolveRef(v.refAudio) === refAudio);
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
  const ref = resolveRef(refAudio);
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
  const refAudio = resolveRef(opts && opts.refAudio);
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
      const hit = (voices || []).find(v => resolveRef(v.refAudio) === refAudio);
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
  // ===== 游戏窗口自适应 =====
  // 思路：让【窗口】去适应【游戏真实尺寸】（窗口本来就浮动）；只有游戏比屏幕可用区还大时才等比缩小，
  // 并用浏览器自身的溢出信号(scrollWidth>clientWidth)迭代收敛缩放，直到彻底没有滚动条。
  let fitApplied = false;
  const measureOverflow = () => gameWin.webContents.executeJavaScript(`(function(){
    var d = document.documentElement, b = document.body;
    return {
      w: Math.max(d.scrollWidth, b?b.scrollWidth:0, d.clientWidth),
      h: Math.max(d.scrollHeight, b?b.scrollHeight:0, d.clientHeight),
      overH: d.scrollWidth > d.clientWidth + 1,
      overV: d.scrollHeight > d.clientHeight + 1
    };
  })()`);
  async function fitGameWindow() {
    if (!gameWin || gameWin.isDestroyed()) return;
    try {
      // 固定窗口 414x736（保持小巧舒服的原始尺寸，不放大）
      gameWin.setContentSize(GAME_W, GAME_H);
      gameWin.webContents.setZoomFactor(1);
      await new Promise(r => setTimeout(r, 150));
      const m = await measureOverflow();
      if (!m || m.w < 50 || m.h < 50) return; // 还在 loading，等下一轮

      let z = 1;
      // 关键：只有固定窗口下出现滚动条（内容溢出）时，才缩小内容去适配 414x736；
      // 没有滚动条就保持 1:1 原样，不做任何缩放。
      if (m.overH || m.overV) {
        for (let i = 0; i < 14; i++) {
          z *= 0.95;
          gameWin.webContents.setZoomFactor(z);
          await new Promise(r => setTimeout(r, 130));
          const o = await measureOverflow();
          if (!o) break;
          if (!o.overH && !o.overV) break; // 无溢出了
          if (z < 0.3) break;
        }
      }
      fitApplied = true;
      // 点击换算基准 = CSS 视口宽高 = 窗口尺寸 / 缩放比
      aiAgent.pageW = GAME_W / z;
      aiAgent.pageH = GAME_H / z;
      console.log('[fit-game] 固定窗口 ' + GAME_W + 'x' + GAME_H + '：' +
        (z < 0.999 ? ('内容 ' + m.w + 'x' + m.h + ' 有滚动条，缩放 ' + z.toFixed(3) + ' 适配') : '无滚动条，1:1 原样显示') +
        '，点击基准 ' + aiAgent.pageW.toFixed(0) + 'x' + aiAgent.pageH.toFixed(0));
    } catch (e) { console.log('[fit-game-err] ' + e); }
  }
  const kickFit = () => {
    let n = 0;
    const tick = async () => {
      if (!gameWin || gameWin.isDestroyed() || n++ > 20) return;
      if (!fitApplied) await fitGameWindow();
      if (!fitApplied) setTimeout(tick, 800);
    };
    setTimeout(tick, 600);
  };
  gameWin.webContents.on('did-finish-load', () => { fitApplied = false; kickFit(); });
  gameWin.webContents.on('did-navigate', () => { fitApplied = false; kickFit(); });
  kickFit();
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

// 取点击坐标（0~1 相对比例）。优先级：
// ① box 边界框 [左,上,右,下] → 取四边中点（模型判断"目标四边在哪"比判断"中心在哪"更准，四边平均能抵掉单边误差）
// ② 旧式 x/y → 直用（兼容）
function actionXY(ac) {
  const box = ac && ac.box;
  if (Array.isArray(box) && box.length >= 4) {
    let x1 = Number(box[0]), y1 = Number(box[1]), x2 = Number(box[2]), y2 = Number(box[3]);
    if ([x1, y1, x2, y2].every(Number.isFinite)) {
      // 模型有时返回像素坐标而非 0~1 比例：若任一值 >1 且整体像像素（如 569/1303），按图片尺寸归一到 0~1
      if (x1 > 1 || y1 > 1 || x2 > 1 || y2 > 1) {
        const w = aiAgent.lastImgW || 0, h = aiAgent.lastImgH || 0;
        if (w > 1 && h > 1) { x1 /= w; x2 /= w; y1 /= h; y2 /= h; }
        else return { x: Number(ac.x), y: Number(ac.y), via: 'xy' }; // 无尺寸参考，无法换算
      }
      // 归一后仍须落在 0~1，否则视为无效框
      if ([x1, y1, x2, y2].every(n => n >= 0 && n <= 1)) {
        const lx = Math.min(x1, x2), rx = Math.max(x1, x2), ty = Math.min(y1, y2), by = Math.max(y1, y2);
        const cx = (lx + rx) / 2, cy = (ty + by) / 2;
        return { x: Math.round(cx * 10000) / 10000, y: Math.round(cy * 10000) / 10000, via: 'box' };
      }
    }
  }
  return { x: Number(ac && ac.x), y: Number(ac && ac.y), via: 'xy' };
}
async function doTap(x, y) {
  // 坐标统一换算：>1 视为绝对像素（旧脚本 / AI 视觉计划），否则视为 0~1 相对比例 → 按当前窗口实际尺寸换算
  let px = Number(x), py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    console.log('[doTap] 非法坐标已跳过: x=' + x + ' y=' + y);
    return false;
  }
  let cw = GAME_W, ch = GAME_H;
  if (gameWin && !gameWin.isDestroyed()) {
    const s = gameWin.getContentSize();
    if (s && s.width > 0 && s.height > 0) { cw = s.width; ch = s.height; }
  }
  // 若已知页面真实可见内容区（不含滚动条），用它做换算基准，避免滚动条导致的偏移
  if (aiAgent.pageW > 0 && aiAgent.pageH > 0) { cw = aiAgent.pageW; ch = aiAgent.pageH; }
  if (px <= 1) px *= cw;
  if (py <= 1) py *= ch;
  px = Math.max(0, Math.min(cw, Math.round(px)));
  py = Math.max(0, Math.min(ch, Math.round(py)));
  console.log('[doTap] 模型坐标(' + x + ',' + y + ') → 像素(' + px + ',' + py + ') 窗口' + cw + 'x' + ch);
  if (auto.options.method === 'cdp') await cdpTap(px, py);
  else await softTap(px, py);
  return true;
}

// ---------- 画面相似度（用于判定过关/切屏） ----------
async function signature() {
  if (!gameWin || gameWin.isDestroyed()) return null;
  const page = await gameWin.webContents.capturePage();
  return signatureOf(page);
}
function similarity(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += 1 - Math.abs(a[i] - b[i]);
  return s / a.length;
}
// 点击后校验：轮询截图，直到画面相对 before 明显变化或超时，返回是否变化
// 注意：CDP 点击本身几乎总是成功的（能到达页面 DOM/Canvas）。
// 画面"没变化"可能只是这一下没有视觉反馈（点空白、等输入、动画已结束），
// 所以这里只回答"画面有没有视觉变化"，不能等同于"点击失败"。
async function waitScreenChange(before, timeoutMs = 4000) {
  if (!gameWin || gameWin.isDestroyed() || !before) return true; // 拿不到基准就当作已变化，避免误报
  const base = signatureOf(before);
  const t0 = Date.now();
  // 采样更密集、观察窗口更长：输入框/按钮常有 300~800ms 的渐显动画，
  // 采样太稀会正好错过峰值，把"其实生效了"误判成"没变化"。
  let maxDiff = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (aiAgent.abort) return true;
    if (!gameWin || gameWin.isDestroyed()) return true;
    try {
      const now = await gameWin.webContents.capturePage();
      const sig = signatureOf(now);
      if (base && sig) {
        const sim = similarity(base, sig);
        const diff = 1 - sim;
        if (diff > maxDiff) maxDiff = diff;
        if (sim < TAP_CHANGE_SIM) return true; // 任一时刻达到变化阈值就判定生效
      }
    } catch (e) { return true; }
    await sleep(150); // 密集采样
  }
  // 没达到阈值也记录一下最大差异，便于排查是否阈值偏严
  if (maxDiff > 0) console.log('[screen-change] 未达阈值，窗口内最大差异=' + maxDiff.toFixed(5) + '（阈值 ' + (1 - TAP_CHANGE_SIM).toFixed(5) + '）');
  return false; // 超时无视觉变化
}
// 从已截好的 NativeImage 算灰度指纹（20x36），避免重复截图
const SIG_W = 96, SIG_H = 172; // 采样分辨率：提高后"只变一个格子"的变化也能占到更多采样点，不易漏检
function signatureOf(page) {
  if (!page) return null;
  const tiny = page.resize({ width: SIG_W, height: SIG_H });
  const bmp = tiny.toBitmap();
  const n = SIG_W * SIG_H;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    sig[i] = (0.299 * bmp[o] + 0.587 * bmp[o + 1] + 0.114 * bmp[o + 2]) / 255;
  }
  return sig;
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
  if (auto.recording) { setStatus('当前已在录制中'); return; }
  // 已有脚本 → 追加新关接着录（保留已有关卡）；最后一关没点 → 直接复用该关；无脚本 → 从 L1 新建
  let script = readScript(auto.gameId);
  let msg;
  if (script && script.levels && script.levels.length) {
    auto.script = script;
    const last = script.levels[script.levels.length - 1];
    if (last.taps && last.taps.length === 0) {
      msg = '从第 ' + script.levels.length + ' 关开始录制（该关还没有点）';
    } else {
      const n = script.levels.length + 1;
      script.levels.push({ name: 'L' + n, taps: [] });
      msg = '开始录制第 ' + n + ' 关…（已有 ' + (script.levels.length - 1) + ' 关保留）';
    }
  } else {
    auto.script = {
      gameId: auto.gameId,
      window: { w: GAME_W, h: GAME_H },
      levels: [ { name: 'L1', taps: [] } ],
      recordedAt: new Date().toISOString()
    };
    msg = '开始录制第 1 关…';
  }
  auto.recording = true;
  auto.lastTapTime = Date.now();
  if (auto.options.autoMark) startAutoMark();
  setStatus(msg + (auto.options.autoMark ? '，自动标记已开启' : ''));
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
// 关卡开始前的可中断倒计时：每秒推一次剩余秒数给面板显示；停止/中止时立即返回 false。
// 返回 true = 倒计时正常走完；false = 被中止（调用方应停止本关及后续）
async function countdownBeforeLevel(seconds, levelNo) {
  let remain = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!remain) {
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('play:countdown', { active: false });
    return true;
  }
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('play:countdown', { active: true, remain, level: levelNo });
  const endAt = Date.now() + remain * 1000;
  while (auto.playing && !auto.abort) {
    const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
    if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('play:countdown', { active: true, remain: left, level: levelNo });
    if (left <= 0) break;
    await sleep(200); // 细粒度轮询，保证停止能及时中断
  }
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('play:countdown', { active: false });
  return auto.playing && !auto.abort;
}
async function startPlayback(startIdx = 1, delaySec = 0) {
  if (auto.playing) return;
  const file = path.join(SCRIPTS_DIR, auto.gameId + '.json');
  if (!fs.existsSync(file)) { setStatus('还没有该游戏的脚本，请先录制'); return; }
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (startIdx < 1) startIdx = 1;
  if (startIdx > script.levels.length) startIdx = script.levels.length;
  auto.playing = true;
  auto.abort = false;
  if (gameWin && !gameWin.isDestroyed()) gameWin.focus();
  setStatus('自动玩从第 ' + startIdx + ' 关开始' + (auto.options.loop ? '（循环）' : ''));
  let li = startIdx - 1;
  while (auto.playing && !auto.abort) {
    const level = script.levels[li];
    if (level && level.taps.length) {
      // 关卡开始前倒计时（每秒推送到面板显示；停止可立即中断）
      if (delaySec > 0) {
        setStatus('第 ' + (li + 1) + ' 关准备中：' + delaySec + ' 秒后开始…', { playing: true });
        const go = await countdownBeforeLevel(delaySec, li + 1);
        if (!go) break; // 倒计时期间被停止
      }
      auto.highlight = li + 1; // 当前正在播的关高亮
      sendLevels();
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
      if (auto.options.loop) { li = startIdx - 1; await sleep(1000); } // 循环：从填写的关重新开始
      else break; // 不循环：玩完最后一关停止
    }
  }
  auto.playing = false;
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('play:countdown', { active: false });
  if (auto.highlight) { auto.highlight = 0; sendLevels(); }
  setStatus(auto.abort ? '已停止' : '自动玩结束（已播完第 ' + script.levels.length + ' 关）');
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
  if (auto.phase === 'prep') auto.phase = ''; // 重录推进结束（含中止），清准备标记
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

// 测试某一关：在当前画面直接播放该关录制的点击（不推进到该关，只点这一遍）
function testLevelAt(idx) {
  const script = readScript(auto.gameId);
  if (!script) { setStatus('没有脚本'); return; }
  if (idx >= script.levels.length) {
    dialog.showMessageBox({
      type: 'warning',
      message: '该关不存在',
      detail: '当前脚本只有 ' + script.levels.length + ' 关（' + script.levels.map(l => l.name).join('、') + '）。'
    });
    return;
  }
  if (auto.playing || auto.recording) { setStatus('请先停止录制/回放再测试'); return; }
  const level = script.levels[idx];
  if (!level.taps.length) { setStatus('该关还没有录制点，先录制'); return; }
  auto.abort = false; // 清除上次停止留下的标志
  auto.phase = 'test';
  auto.playing = true;
  auto.highlight = idx + 1; // 选中高亮当前测试的关
  sendLevels();
  setStatus('测试第 ' + (idx + 1) + ' 关（当前画面执行 ' + level.taps.length + ' 个点）…');
  (async () => {
    try {
      if (gameWin && !gameWin.isDestroyed()) gameWin.focus();
      for (const t of level.taps) {
        if (auto.abort) break;
        await sleep(Math.max(0, t.delay) / auto.options.speed);
        await doTap(t.x, t.y);
      }
    } finally {
      // 无论正常结束、中途停止还是抛异常，都确保取消高亮（避免残留假选中）
      auto.playing = false;
      auto.phase = '';
      if (auto.highlight) { auto.highlight = 0; sendLevels(); }
      setStatus(auto.abort ? '测试已停止' : '第 ' + (idx + 1) + ' 关测试完成，已点击 ' + level.taps.length + ' 次');
    }
  })();
}

// 重录某一关：清空该关及之后的点，直接在当前画面开始录制（不自动推进）
function reRecordAt(idx) {
  const script = readScript(auto.gameId);
  if (!script) { setStatus('没有可重录的脚本'); return; }
  if (idx >= script.levels.length) {
    dialog.showMessageBox({
      type: 'warning',
      message: '该关不存在',
      detail: '当前脚本只有 ' + script.levels.length + ' 关。请先录制到这一关再重录。'
    });
    return;
  }
  if (auto.recording || auto.playing) { setStatus('请先停止录制/回放再重录'); return; }
  // 截断到该关（该关及之后作废），该关点清零
  const was = script.levels[idx].taps.length;
  script.levels = script.levels.slice(0, idx + 1);
  script.levels[idx].taps = [];
  auto.script = script;
  saveScript(auto.gameId, script);
  // 直接进入录制：追加点会写入最后一关（= 当前重录的这一关）
  auto.recording = true;
  auto.lastTapTime = Date.now();
  if (auto.options.autoMark) startAutoMark();
  sendLevels();
  setStatus('已清空第 ' + (idx + 1) + ' 关（原 ' + was + ' 个点），开始重录——直接操作游戏即可');
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
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('play:countdown', { active: false }); // 隐藏倒计时
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
  if (g) {
    // 若该游戏绑定了模板且勾了「自动加载」，打开游戏前先切换配置
    if (g.templateId && g.autoTemplate) {
      const r = tplLoadInto(g.templateId);
      if (!r.ok) console.log('[tpl] 游戏「' + g.name + '」自动加载模板失败：' + r.error);
    }
    startGame(g);
  }
  return !!g;
});

// 游戏窗口静音开关（直播时不想让观众听到游戏原声，可一键静音；传 boolean=设定，不传=切换）
ipcMain.handle('game:mute', (e, muted) => {
  if (!gameWin || gameWin.isDestroyed()) return false;
  if (typeof muted === 'boolean') gameWin.webContents.setAudioMuted(muted);
  else gameWin.webContents.setAudioMuted(!gameWin.webContents.isAudioMuted());
  return !!gameWin.webContents.isAudioMuted();
});

// ---------- 客户端配置文件 ----------
// client-config.json：所有非模型配置（aiChat 通用项 / tts / danmaku 等）
// models.json：模型提供商配置（API 地址 / Key / 文本模型 / 视觉模型），从 client-config 拆出，独立管理
// 内存中仍统一用 clientConfig.aiChat.customProviders 作为唯一数据源，所有读取处无需改动；
// 只在落盘时分流：模型列表 → models.json，其余 → client-config.json。
const CONFIG_DIR = path.join(__dirname, '..', 'config');
const CONFIG_PATH = path.join(CONFIG_DIR, 'client-config.json');
const MODELS_PATH = path.join(CONFIG_DIR, 'models.json');
const DEFAULT_CONFIG = {
  version: 1,
  aiChat: {
    qwenKey: '', qwenModel: 'qwen3-tts-flash',
    baiduAk: '', baiduSk: '',
    aiPrompt: '我是一个小游戏主播，我现在玩的游戏是我要动个脑，如果有用户问玩的什么游戏，请替我回答，只回答用户的提问，其他弹幕不用回答，如果用户问什么游戏，用不同的风格去回复用户，字数在15个字左右',
    aiFilter: '', aiCool: '', aiRetry: '', aiFallback: true, aiFallOrder: '',
    aiOn: false, aiVoice: false, aiText: false,
    aiModelId: '', aiVisionOn: false,
    customProviders: [] // 落盘时不写这里，见 saveClientConfig / writeClientConfigFile
  }
};
let clientConfig = null;
// 旧版内置 4 家字段 → 统一迁移为 customProviders 自定义配置
const LEGACY_BUILTIN = [
  { id: 'dsk', label: 'DeepSeek', keyField: 'dskKey', baseField: 'dskBase', textField: 'dskModel', visionField: null, defBase: 'https://api.deepseek.com', defText: 'deepseek-v4-flash', defVision: null },
  { id: 'zhipu', label: '智谱 GLM', keyField: 'zhipuKey', baseField: 'zhipuBase', textField: 'zhipuModel', visionField: 'visionModel', defBase: 'https://open.bigmodel.cn/api/paas/v4', defText: 'glm-4.7-flash', defVision: 'glm-4.6v-flash' },
  { id: 'silicon', label: '硅基流动', keyField: 'siliconKey', baseField: 'siliconBase', textField: 'siliconModel', visionField: null, defBase: 'https://api.siliconflow.cn/v1', defText: '', defVision: null },
  { id: 'sensenova', label: '商汤 SenseNova', keyField: 'sensenovaKey', baseField: 'sensenovaBase', textField: 'sensenovaModel', visionField: 'sensenovaVisionModel', defBase: 'https://token.sensenova.cn/v1', defText: 'sensenova-6.7-flash-lite', defVision: null }
];
// 首次无配置时预置的 4 个空自定义卡片（带好默认 base，用户直接填 Key 即可）
const DEFAULT_CUSTOM_PROVIDERS = [
  { id: 'dsk', label: 'DeepSeek', base: 'https://api.deepseek.com', key: '', textModel: 'deepseek-v4-flash', visionModel: '' },
  { id: 'zhipu', label: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', key: '', textModel: 'glm-4.7-flash', visionModel: 'glm-4.6v-flash' },
  { id: 'silicon', label: '硅基流动', base: 'https://api.siliconflow.cn/v1', key: '', textModel: '', visionModel: '' },
  { id: 'sensenova', label: '商汤 SenseNova', base: 'https://token.sensenova.cn/v1', key: '', textModel: 'sensenova-6.7-flash-lite', visionModel: '' }
];
function migrateBuiltinToCustom(aiChat) {
  if (!aiChat || typeof aiChat !== 'object') return aiChat;
  const list = Array.isArray(aiChat.customProviders) ? aiChat.customProviders.slice() : [];
  const have = new Set(list.map(x => x && x.id));
  for (const b of LEGACY_BUILTIN) {
    const key = String(aiChat[b.keyField] || '').trim();
    if (!key) continue; // 没填过 Key 的旧内置家，跳过（首次会由默认卡片补上）
    if (have.has(b.id)) continue; // 已存在于自定义，不重复
    have.add(b.id);
    list.push({
      id: b.id, label: b.label,
      base: String(aiChat[b.baseField] || b.defBase || '').trim(),
      key: key,
      textModel: String(aiChat[b.textField] || b.defText || '').trim(),
      visionModel: b.visionField ? String(aiChat[b.visionField] || b.defVision || '').trim() : ''
    });
  }
  aiChat.customProviders = list;
  // 清理旧字段，避免混淆
  for (const b of LEGACY_BUILTIN) { delete aiChat[b.keyField]; delete aiChat[b.baseField]; delete aiChat[b.textField]; if (b.visionField) delete aiChat[b.visionField]; }
  delete aiChat.provider;
  return aiChat;
}
// 读模型列表：优先 models.json；不存在则从旧 client-config.json 的 aiChat.customProviders 迁移
function loadModelsFile() {
  try {
    if (fs.existsSync(MODELS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw.providers) ? raw.providers : null);
      if (list) return list;
    }
  } catch (e) {}
  return null;
}
function saveModelsFile(list) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(MODELS_PATH, JSON.stringify({ version: 1, providers: list }, null, 2), 'utf8');
  } catch (e) {}
}
// 写 client-config.json：剔除 model 列表（它归 models.json 管）
function writeClientConfigFile() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const toSave = JSON.parse(JSON.stringify(clientConfig || {}));
    if (toSave.aiChat) delete toSave.aiChat.customProviders;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {}
}
function loadClientConfig(){
  let legacyProviders = null; // 旧版嵌在 client-config 里的模型列表，用于一次性迁移
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      // 保留所有顶层分区（aiChat / tts / danmaku 等），不要只挑 aiChat——否则其他配置每次都会被丢弃
      clientConfig = Object.assign({}, raw, {
        version: 1,
        aiChat: Object.assign({}, DEFAULT_CONFIG.aiChat, (raw.aiChat || {}))
      });
      legacyProviders = clientConfig.aiChat.customProviders;
    } else {
      clientConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  } catch (e) {
    clientConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  // 旧内置字段 → customProviders（兼容很老的版本）
  clientConfig.aiChat = migrateBuiltinToCustom(clientConfig.aiChat);
  // 模型列表：models.json 优先 → 旧 client-config 里迁移 → 默认预置
  let models = loadModelsFile();
  if (!models || !models.length) {
    models = (Array.isArray(legacyProviders) && legacyProviders.length)
      ? legacyProviders
      : (Array.isArray(clientConfig.aiChat.customProviders) && clientConfig.aiChat.customProviders.length
          ? clientConfig.aiChat.customProviders
          : JSON.parse(JSON.stringify(DEFAULT_CUSTOM_PROVIDERS)));
  }
  clientConfig.aiChat.customProviders = models;
  // 分流落盘：模型 → models.json，其余 → client-config.json（顺便把旧文件里的模型字段清掉）
  saveModelsFile(models);
  writeClientConfigFile();
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
  // 若本次改动了模型列表，单独写 models.json；client-config.json 永不写模型字段
  if (patch && patch.aiChat && Array.isArray(patch.aiChat.customProviders)) {
    saveModelsFile(clientConfig.aiChat.customProviders);
  }
  writeClientConfigFile();
  return clientConfig;
}
loadClientConfig(); // 客户端启动即加载
ipcMain.handle('cfg:load', () => loadClientConfig());
ipcMain.handle('cfg:save', (e, patch) => saveClientConfig(patch));

// ---------- 配置模板（config/templates/*.json） ----------
// 每个模板是一份配置快照：{ aiChat, tts, danmaku }（模型 Key 在全局 models.json，不进模板）。
// client-config.json 始终是「当前生效配置」；加载模板=把快照写回当前配置并通知界面刷新。
// 游戏可绑定模板：games.json 里加 templateId + autoTemplate；启动游戏时可选自动加载。
const CFG_TPL_DIR = path.join(CONFIG_DIR, 'templates');
try { fs.mkdirSync(CFG_TPL_DIR, { recursive: true }); } catch (e) {}
function tplFile(id) { return path.join(CFG_TPL_DIR, path.basename(String(id || '')) + '.json'); }
function tplList() {
  const files = [];
  try { files.push(...fs.readdirSync(CFG_TPL_DIR).filter(f => /\.json$/i.test(f))); } catch (e) {}
  const games = readGames();
  return files.map(f => {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(CFG_TPL_DIR, f), 'utf8'));
      return {
        id: t.id || path.basename(f, '.json'),
        name: t.name || t.id || path.basename(f, '.json'),
        note: t.note || '',
        builtin: !!t.builtin,
        createdAt: t.createdAt || 0,
        updatedAt: t.updatedAt || 0,
        sections: Object.keys(t.config || {}),
        boundGames: games.filter(g => g.templateId === (t.id || path.basename(f, '.json')))
                         .map(g => ({ id: g.id, name: g.name, auto: !!g.autoTemplate }))
      };
    } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function tplRead(id) {
  try { return JSON.parse(fs.readFileSync(tplFile(id), 'utf8')); } catch (e) { return null; }
}
function tplWrite(t) {
  t.updatedAt = Date.now();
  fs.mkdirSync(CFG_TPL_DIR, { recursive: true });
  fs.writeFileSync(tplFile(t.id), JSON.stringify(t, null, 2), 'utf8');
  return t;
}
// 当前配置快照（不含 customProviders，模型 Key 归 models.json 全局管）
function tplSnapshot() {
  const c = clientConfig || {};
  const ai = Object.assign({}, c.aiChat || {});
  delete ai.customProviders;
  return { aiChat: ai, tts: Object.assign({}, c.tts || {}), danmaku: Object.assign({}, c.danmaku || {}) };
}
// 把模板快照写回当前配置（内存 + 磁盘），保留全局模型列表不被覆盖
function tplApply(snap) {
  if (!snap || typeof snap !== 'object') return false;
  for (const k of ['aiChat', 'tts', 'danmaku']) {
    if (snap[k] && typeof snap[k] === 'object') {
      clientConfig[k] = Object.assign({}, clientConfig[k] || {}, snap[k]);
    }
  }
  // 模型列表始终取全局 models.json，不受模板影响
  const models = loadModelsFile();
  if (models && models.length) clientConfig.aiChat.customProviders = models;
  writeClientConfigFile();
  return true;
}
function tplNotifyLoaded(id) {
  if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send('cfg:templateLoaded', { id: id || '' });
}
// 把某个模板设为当前配置（供 IPC 与游戏启动自动加载共用）
function tplLoadInto(id) {
  const t = tplRead(id);
  if (!t) return { ok: false, error: '模板不存在' };
  if (!tplApply(t.config || {})) return { ok: false, error: '模板内容无效' };
  clientConfig.activeTemplateId = t.id; // 记录当前模板，界面可高亮
  writeClientConfigFile();
  tplNotifyLoaded(t.id);
  console.log('[tpl] 已加载模板「' + t.name + '」(' + t.id + ')');
  return { ok: true, id: t.id, name: t.name };
}

ipcMain.handle('tpl:list', () => ({ activeId: (clientConfig && clientConfig.activeTemplateId) || '', templates: tplList() }));
// from: 'current'（当前配置）| 'blank'（空白） | 模板 id（复制某模板）
ipcMain.handle('tpl:add', (e, p) => {
  p = p || {};
  const name = String(p.name || '').trim() || '未命名模板';
  const id = 'tpl_' + Date.now();
  let config;
  if (p.from && p.from !== 'current' && p.from !== 'blank') {
    const src = tplRead(p.from);
    if (!src) return { ok: false, error: '要复制的模板不存在' };
    config = JSON.parse(JSON.stringify(src.config || {}));
  } else if (p.from === 'blank') {
    config = { aiChat: {}, tts: {}, danmaku: {} };
  } else {
    config = tplSnapshot();
  }
  const t = { id, name, note: String(p.note || ''), builtin: false, createdAt: Date.now(), updatedAt: 0, config };
  tplWrite(t);
  return { ok: true, id, name };
});
ipcMain.handle('tpl:update', (e, p) => {
  if (!p || !p.id) return { ok: false, error: '缺少模板 ID' };
  const t = tplRead(p.id);
  if (!t) return { ok: false, error: '模板不存在' };
  if (p.name !== undefined) t.name = String(p.name || '').trim() || t.name;
  if (p.note !== undefined) t.note = String(p.note || '');
  tplWrite(t);
  return { ok: true };
});
ipcMain.handle('tpl:overwrite', (e, id) => {
  const t = tplRead(id);
  if (!t) return { ok: false, error: '模板不存在' };
  t.config = tplSnapshot();
  tplWrite(t);
  return { ok: true };
});
ipcMain.handle('tpl:delete', (e, id) => {
  const t = tplRead(id);
  if (!t) return { ok: true }; // 已不存在，幂等
  if (t.builtin) return { ok: false, error: '内置模板不可删除' };
  try { fs.unlinkSync(tplFile(id)); } catch (err) {}
  // 解绑所有引用该模板的游戏
  const list = readGames();
  let changed = false;
  for (const g of list) if (g.templateId === id) { delete g.templateId; delete g.autoTemplate; changed = true; }
  if (changed) writeGames(list);
  if (clientConfig && clientConfig.activeTemplateId === id) {
    clientConfig.activeTemplateId = '';
    writeClientConfigFile();
  }
  return { ok: true };
});
ipcMain.handle('tpl:load', (e, id) => tplLoadInto(id));
// 游戏绑定模板：templateId 为空表示解绑；auto 表示启动游戏时自动加载
ipcMain.handle('tpl:bindGame', (e, p) => {
  if (!p || !p.gameId) return { ok: false, error: '缺少游戏 ID' };
  const list = readGames();
  const g = list.find(x => x.id === p.gameId);
  if (!g) return { ok: false, error: '游戏不存在' };
  const id = String(p.templateId || '');
  if (id) {
    if (!tplRead(id)) return { ok: false, error: '模板不存在' };
    g.templateId = id;
    g.autoTemplate = !!p.auto;
  } else {
    delete g.templateId;
    delete g.autoTemplate;
  }
  writeGames(list);
  return { ok: true, games: list };
});
// 打开模板目录（方便手动备份/管理）
ipcMain.handle('tpl:openDir', async () => { try { await shell.openPath(CFG_TPL_DIR); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } });

ipcMain.on('game:pointer', (e, p) => {
  if (auto.recording && auto.script) {
    const now = Date.now();
    const level = auto.script.levels[auto.script.levels.length - 1];
    // 存 0~1 相对比例坐标。p.x 是 clientX（CSS 像素），必须用 CSS 视口尺寸(aiAgent.pageW)换算——
    // 窗口缩放后 CSS 视口 != getContentSize(物理)，用物理尺寸会把比例算错(>1)。
    let cw = (aiAgent.pageW > 0 ? aiAgent.pageW : GAME_W);
    let ch = (aiAgent.pageH > 0 ? aiAgent.pageH : GAME_H);
    if (!(aiAgent.pageW > 0) && gameWin && !gameWin.isDestroyed()) {
      const s = gameWin.getContentSize();
      if (s && s.width > 0 && s.height > 0) { cw = s.width; ch = s.height; }
    }
    level.taps.push({ x: +(Number(p.x) / cw).toFixed(4), y: +(Number(p.y) / ch).toFixed(4), delay: now - auto.lastTapTime });
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
ipcMain.on('play:start', (e, startIdx, delaySec) => startPlayback(startIdx || 1, Math.max(0, Number(delaySec) || 0)));
ipcMain.on('play:stop', stopPlayback);
// 当前游戏的备注（面板多行输入框）：存到 autoplay.json 的 <gameId>.note，独立于 auto.options
ipcMain.handle('note:get', () => {
  if (!auto.gameId) return '';
  try { const v = readAutoplayConfig()[auto.gameId]; return (v && typeof v.note === 'string') ? v.note : ''; } catch (e) { return ''; }
});
ipcMain.on('note:set', (e, text) => {
  if (!auto.gameId) return;
  const map = readAutoplayConfig();
  const node = Object.assign({}, map[auto.gameId] || {});
  node.note = String(text == null ? '' : text);
  map[auto.gameId] = node;
  writeAutoplayConfig(map);
});
// AI 指令模板：按游戏存 [{id,name,text}] + 当前选中的 id（aiCmdActive）
ipcMain.handle('aiTpl:load', () => {
  if (!auto.gameId) return { templates: [], activeId: '' };
  const node = readAutoplayConfig()[auto.gameId] || {};
  return {
    templates: Array.isArray(node.aiCmdTemplates) ? node.aiCmdTemplates : [],
    activeId: node.aiCmdActive || ''
  };
});
ipcMain.handle('aiTpl:save', (e, data) => {
  if (!auto.gameId) return { ok: false, error: '未打开游戏' };
  const map = readAutoplayConfig();
  const node = Object.assign({}, map[auto.gameId] || {});
  node.aiCmdTemplates = Array.isArray(data && data.templates) ? data.templates : [];
  node.aiCmdActive = (data && data.activeId) || '';
  map[auto.gameId] = node;
  writeAutoplayConfig(map);
  return { ok: true };
});
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

// ---------- AI 智能决策：逐步截图 → 视觉模型决策 → 执行（智谱主 / 商汤降级 + 重试） ----------
// 与脚本回放（自动玩）互不影响：独立 playing 状态、独立启停；复用 doTap 的 0~1 相对坐标换算
const aiAgent = { playing: false, abort: false, note: '', lastImgW: 0, lastImgH: 0, pageW: 0, pageH: 0 };
let lastTapFeedback = ''; // 上一轮点击"可能没点中"的反馈，下一轮提示词带上
let tapHistory = [];      // 最近几轮的点击记录（供上下文参考）
let levelCount = 0;         // 连续过关计数（持续任务用）
// 模型曾自称通关但被判定为误判的轮数（防过度自信的 done）
let doneClaims = 0;
// 思考预算：推理模型的思考内容会挤占 max_tokens，一旦占满就 finish_reason=length 且 content 为空。
// 视觉任务需分析整幅画面，思考量最大，给足额度；文本任务相对小。
const VISION_MAX_TOKENS = 16384;
const TEXT_MAX_TOKENS = 8192;
// 请求超时：看图 + 推理本身更慢，给视觉更长时间；超时会中止并提示"等待超时"
const VISION_TIMEOUT_MS = 180000; // 3 分钟
const TEXT_TIMEOUT_MS = 90000;    // 1.5 分钟
// 画面相似度阈值：点击后低于此值视为"画面已变化（点击生效）"；高于 STUCK_SIM 视为"几乎没变化（卡住）"
// 判定"画面是否因这次点击而变化"的阈值：越高越灵敏。
// 点一个数字键只影响约 1.2% 画面，用 0.995 会漏判成"没点中"，导致同一坐标反复重试。
const TAP_CHANGE_SIM = 0.9985;
const STUCK_SIM = 0.995;
// 模型自称 done 时，需要连续这么多轮都判断通关才真的停止（避免一次误判就结束）
const DONE_CONFIRM_ROUNDS = 2;

// ---------- AI 决策 trace 落盘（config/ai-trace/<会话>/） ----------
// 每轮：策略文本、发给模型的截图、hint、模型原始返回、解析出的动作、每个点击的坐标与"是否生效"、最终状态。
// 目的：AI 点偏/乱点/误判通关时，打开这一轮的截图和坐标就能一眼复盘，不用翻控制台日志。
const TRACE_DIR = path.join(CONFIG_DIR, 'ai-trace');
let traceSession = null;   // { dir, startedAt, gameId, goal, rounds:[], seq }
function traceEnabled() {
  try { const a = clientConfig && clientConfig.aiChat; return !a || a.aiTrace !== false; } catch (e) { return true; }
}
function traceStart(gameId, goal, cfg) {
  traceSession = null;
  if (!traceEnabled()) return;
  try {
    const id = 'T' + Date.now();
    const dir = path.join(TRACE_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    traceSession = { dir, id, startedAt: Date.now(), gameId: gameId || '', goal: goal || '', rounds: [], seq: 0, end: '' };
    // 会话元信息：指令 + 模型选择 + 游戏规则摘要
    const meta = {
      id, startedAt: new Date(traceSession.startedAt).toISOString(),
      gameId: traceSession.gameId, goal: traceSession.goal,
      visionModel: (cfg && cfg.visionModel) || '', textModel: (cfg && cfg.textModel) || '',
      oneShot: !!(cfg && cfg.oneShot)
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    console.log('[ai-trace] 会话 ' + dir);
  } catch (e) { traceSession = null; }
}
function traceWrite() {
  if (!traceSession) return;
  try {
    const file = path.join(traceSession.dir, 'trace.json');
    fs.writeFileSync(file, JSON.stringify({
      id: traceSession.id, startedAt: traceSession.startedAt, endAt: Date.now(),
      gameId: traceSession.gameId, goal: traceSession.goal,
      rounds: traceSession.rounds, end: traceSession.end || ''
    }, null, 2), 'utf8');
  } catch (e) {}
}
function traceRound(rec) {
  if (!traceSession) return;
  try {
    traceSession.seq++;
    const n = traceSession.seq;
    const r = Object.assign({ n, t: Date.now() }, rec);
    // 截图存文件，trace.json 里只留文件名，避免 JSON 巨大
    if (rec && rec.jpg) {
      const shotFile = path.join(traceSession.dir, ('shot-' + String(n).padStart(3, '0') + '.jpg'));
      fs.writeFileSync(shotFile, rec.jpg);
      r.jpgFile = path.basename(shotFile);
      delete r.jpg;
    }
    traceSession.rounds.push(r);
    // 只保留最近 200 轮，防止长时间挂机把内存/文件撑爆
    if (traceSession.rounds.length > 200) traceSession.rounds.shift();
    traceWrite();
  } catch (e) {}
}
function traceEnd(status) {
  if (!traceSession) return;
  traceSession.end = status || '';
  traceWrite();
  console.log('[ai-trace] 会话结束：' + status + '（' + traceSession.rounds.length + ' 轮，' + traceSession.dir + '）');
}
// 从模型返回的 message 里取"正式回答"文本
// 推理模型会把思考塞进 content、或把答案放进 reasoning_content；规则：谁身上有 JSON 就用谁，都没 JSON 时优先 content
function pickModelText(msg) {
  const pick = v => {
    if (Array.isArray(v)) return v.map(p => (p && (p.text || p.content)) || '').join('');
    return v == null ? '' : String(v);
  };
  const content = pick(msg && msg.content).trim();
  const reasoning = pick(msg && (msg.reasoning_content || msg.reasoning)).trim();
  const hasJson = s => /\{[\s\S]*\}/.test(s);
  if (!hasJson(content) && hasJson(reasoning)) return reasoning;
  if (!content && reasoning) return reasoning;
  return content;
}
// 从模型回复提取 JSON（容忍 ```json 包裹与前后多余文字）
function extractJson(s) {
  if (!s) return null;
  const m = String(s).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) {
    try { return JSON.parse(String(s).replace(/```json|```/gi, '').trim()); } catch (e2) { return null; }
  }
}
// 分析"模型未返回有效动作"的具体原因，便于排查（返回一句人话）
function diagnoseBadAction(rawText, parsed) {
  const t = String(rawText || '').trim();
  if (!t) return '模型返回空内容';
  if (!parsed) {
    // 没解析出 JSON：区分"说的是人话"和"JSON 格式坏了"
    if (/[\u4e00-\u9fa5]{4,}/.test(t) && !/[{\[]/.test(t)) return '返回的是自然语言而非 JSON：「' + t.slice(0, 60) + '」';
    if (/[{\[]/.test(t)) return 'JSON 格式有误（括号/逗号不完整或被截断）：「' + t.slice(0, 60) + '」';
    return '未找到 JSON：「' + t.slice(0, 60) + '」';
  }
  // 解析出了 JSON，但结构不对
  if (parsed.actions === undefined) {
    const keys = Object.keys(parsed).slice(0, 5).join(',');
    return '缺少 actions 字段（实际字段：' + (keys || '无') + '）';
  }
  if (!Array.isArray(parsed.actions)) return 'actions 不是数组（类型 ' + typeof parsed.actions + '）';
  if (!parsed.actions.length) {
    const why = String(parsed.reasoning || parsed.note || '').trim();
    return 'actions 为空，模型没给出可执行动作' + (why ? '（模型说：' + why.slice(0, 80) + '）' : '');
  }
  return '未知原因';
}
// 流式请求 chat/completions：只收集 content（正式答案），丢弃 reasoning_content（思考过程）
// 推理模型的思考会占满 max_tokens，非流式时容易整段被截断；流式下两者是独立字段，可精准只取答案。
// 返回 { ok, text, finish, truncated } 或 { ok:false, error, needRetryTemp }
async function chatStreamOnce(url, key, body, timeoutMs = 120000, onReasoning) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(Object.assign({}, body, { stream: true })),
      signal: ac.signal
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      let em = '';
      try { const j = JSON.parse(txt); em = String((j && j.error && (j.error.message || j.error.code)) || ''); } catch (e) {}
      return { ok: false, error: em || txt.slice(0, 200) || ('HTTP ' + r.status), needRetryTemp: /temperature/i.test(em || txt) };
    }
    // 服务端可能不支持流式而直接返回整包 JSON
    const ct = String(r.headers.get('content-type') || '');
    if (!/event-stream/i.test(ct)) {
      const txt = await r.text().catch(() => '');
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (j && j.choices) {
        const ch = j.choices[0] || {};
        return { ok: true, text: pickModelText(ch.message || {}), finish: ch.finish_reason || '', truncated: ch.finish_reason === 'length' };
      }
      return { ok: false, error: '返回格式异常：' + txt.slice(0, 160) };
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', content = '', finish = '', reasoning = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        let j = null; try { j = JSON.parse(data); } catch (e) { continue; }
        const ch = (j.choices && j.choices[0]) || {};
        const d = ch.delta || {};
        // content = 正式答案；reasoning_content = 思考过程（单独累加，可用于界面实时展示）
        const piece = typeof d.content === 'string' ? d.content
          : (Array.isArray(d.content) ? d.content.map(p => (p && (p.text || '')) || '').join('') : '');
        if (piece) content += piece;
        const rp = typeof d.reasoning_content === 'string' ? d.reasoning_content
          : (typeof d.reasoning === 'string' ? d.reasoning : '');
        if (rp) {
          reasoning += rp;
          // 边收边回调，让界面能实时显示"模型正在想什么"（节流由调用方控制）
          if (typeof onReasoning === 'function') { try { onReasoning(rp, reasoning); } catch (e) {} }
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
    return { ok: true, text: content.trim(), reasoning: reasoning.trim(), finish, truncated: finish === 'length' };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 超时是我们自己 abort 的，把底层英文错误翻译成人话，避免误以为是"模型繁忙"
    if (ac.signal.aborted || /aborted|abort/i.test(msg)) {
      return {
        ok: false,
        error: '等待超时（超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有返回完整结果）。' +
          '常见原因：网络慢、中转站上游卡住、或所选推理模型思考过长。可重试，或换更快的模型',
        timeout: true
      };
    }
    return { ok: false, error: msg };
  } finally { clearTimeout(timer); }
}
// 单次视觉对话（OpenAI 兼容），返回 {ok,text,error}
async function aiChatOnce(conf, imgB64, system, history, hintText) {
  try {
    const url = conf.base.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: conf.model,
      messages: [
        { role: 'system', content: system },
        ...(history || []),
        {
          role: 'user',
          content: [
            { type: 'text', text: hintText || '请看当前游戏画面，输出下一步动作 JSON' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imgB64 } }
          ]
        }
      ],
      // 视觉任务思考量最大（要看整个画面做布局分析），给足上限，避免思考占满后答案为空
      max_tokens: VISION_MAX_TOKENS, temperature: 0.3
    };
    // 尽量关闭"思考/推理"输出（能关就关，关不掉的推理模型靠下方流式只取 content 兜底）
    if (/^glm/i.test(conf.model) || /reason/i.test(conf.model)) body.thinking = { type: 'disabled' };
    body.reasoning_effort = 'none';
    // 优先走流式：推理模型的思考会占满 max_tokens，非流式整段被截断拿不到 JSON；
    // 流式下 reasoning_content 与 content 是两个独立字段，只累加 content 就能"直接拿结果"
    const thinkCb = (chunk, all) => pushThinking(all, conf.tag || conf.model);
    let sr = await chatStreamOnce(url, conf.key, body, VISION_TIMEOUT_MS, thinkCb);
    // 部分服务（如商汤 kimi-k3）只接受 temperature=1：命中就用 1 重试一次
    if (!sr.ok && sr.needRetryTemp && body.temperature !== 1) {
      body.temperature = 1;
      sr = await chatStreamOnce(url, conf.key, body, VISION_TIMEOUT_MS, thinkCb);
    }
    lastThinkText = ''; // 本轮思考结束，下一轮重新开始
    if (!sr.ok) { pushThinking('', ''); return { ok: false, error: sr.error }; }
    let text = String(sr.text || '').trim();
    // 思考占满长度上限、正式答案没来得及输出 → 收回额度再要一次，并催它直出结论
    if (!text && sr.finish === 'length') {
      const retryBody = Object.assign({}, body, {
        max_tokens: Math.max(body.max_tokens, VISION_MAX_TOKENS),
        messages: body.messages.map((m, i) =>
          i === 0 ? Object.assign({}, m, { content: m.content + '\n注意：不要长篇推理，直接按格式输出 JSON 结论，思考控制在极简。' }) : m)
      });
      const sr2 = await chatStreamOnce(url, conf.key, retryBody);
      if (sr2.ok && String(sr2.text || '').trim()) { text = String(sr2.text).trim(); sr = sr2; }
    }
    if (!text) return { ok: false, error: '模型返回空内容（思考占满了长度上限，没来得及输出正式答案）' + (sr.finish ? '（finish_reason=' + sr.finish + '）' : '') };
    return { ok: true, text, truncated: !!sr.truncated };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}
// 模型池逐级降级：智谱(主)视觉模型列表 → 商汤(降级)视觉模型列表；每个模型重试 N 次，失败自动切换下一个
// 配置支持逗号分隔（如 visionModel: "glm-4.6v-flash, glm-4.5v"），按书写顺序逐个尝试
function modelList(v) { return String(v || '').split(/[,，]/).map(s => s.trim()).filter(Boolean); }
// 构建可用视觉模型池：遍历所有已填 Key 的自定义提供商，按列表顺序组成降级链；每项带 provider 供面板选择时定位用哪个 Key/Base
function buildVisionPool() {
  const a = (clientConfig && clientConfig.aiChat) || {};
  const pool = [];
  for (const cp of (Array.isArray(a.customProviders) ? a.customProviders : [])) {
    if (!cp || !String(cp.key || '').trim()) continue;
    for (const m of modelList(cp.visionModel)) pool.push({ provider: cp.id, key: String(cp.key).trim(), base: String(cp.base || '').trim(), model: m, tag: cp.label || cp.id });
  }
  return pool;
}
// pick = {provider, model}：指定模型时只用它（不降级）；不传或 'auto' 时走完整降级链路
async function aiVisionAsk(imgB64, system, history, hintText, pick) {
  const a = (clientConfig && clientConfig.aiChat) || {};
  const retry = Math.max(1, Math.min(5, Number(a.aiRetry) || 3));
  const gap = 2000;
  let pool = buildVisionPool();
  if (pick && pick.provider && pick.model) {
    pool = pool.filter(p => p.provider === pick.provider && p.model === pick.model);
    if (!pool.length) return { ok: false, error: '所选模型未配置 Key 或不可用' };
  }
  if (!pool.length) return { ok: false, error: '未配置视觉模型（请在「🧩 模型配置」里为提供商填写视觉模型与 API Key）' };
  let lastErr = '未知错误';
  for (let pi = 0; pi < pool.length; pi++) {
    const item = pool[pi];
    for (let i = 1; i <= retry; i++) {
      if (aiAgent.abort) return { ok: false, error: '已停止' }; // 用户停止 → 立刻放弃剩余重试
      const r = await aiChatOnce({ key: item.key, base: item.base, model: item.model }, imgB64, system, history, hintText);
      if (r.ok) return Object.assign(r, { used: item.tag + ' ' + item.model });
      lastErr = r.error;
      if (i < retry) {
        const why = r.timeout ? '响应超时' : '调用失败';
        setStatus(item.tag + '「' + item.model + '」' + why + '（' + r.error + '），重试 ' + i + '/' + retry + '…', { aiPlaying: true });
        await sleep(gap);
      }
    }
    if (pi < pool.length - 1) setStatus(item.tag + '「' + item.model + '」失败，切换下一个模型…', { aiPlaying: true });
  }
  return { ok: false, error: '全部视觉模型调用失败：' + lastErr };
}
// 文本模型池：遍历所有已填 Key 的自定义提供商，按列表顺序组成降级链
function buildTextPool() {
  const a = (clientConfig && clientConfig.aiChat) || {};
  const pool = [];
  for (const cp of (Array.isArray(a.customProviders) ? a.customProviders : [])) {
    if (!cp || !String(cp.key || '').trim()) continue;
    for (const m of modelList(cp.textModel)) pool.push({ provider: cp.id, tag: cp.label || cp.id, key: String(cp.key).trim(), base: String(cp.base || '').trim(), model: m });
  }
  return pool;
}
// 纯文本调用（不带图）
async function aiTextOnce(conf, system, user) {
  try {
    const url = conf.base.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: conf.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: TEXT_MAX_TOKENS, temperature: 0.3
    };
    // 尽量关闭思考；关不掉的推理模型靠流式只取 content 兜底（思考在 reasoning_content 里，不会混进答案）
    if (/^glm/i.test(conf.model) || /reason/i.test(conf.model)) body.thinking = { type: 'disabled' };
    body.reasoning_effort = 'none';
    let sr = await chatStreamOnce(url, conf.key, body, TEXT_TIMEOUT_MS);
    if (!sr.ok && sr.needRetryTemp && body.temperature !== 1) {
      body.temperature = 1;
      sr = await chatStreamOnce(url, conf.key, body, TEXT_TIMEOUT_MS);
    }
    if (!sr.ok) return { ok: false, error: sr.error };
    const text = String(sr.text || '').trim();
    if (!text) return { ok: false, error: '模型返回空内容（只输出思考没有正式答案）' + (sr.finish ? '（finish_reason=' + sr.finish + '）' : '') };
    return { ok: true, text, truncated: !!sr.truncated };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
// 文本模型调用：pick 指定则只用它（不降级），否则按池顺序降级
async function aiTextAsk(system, user, pick) {
  const a = (clientConfig && clientConfig.aiChat) || {};
  const retry = Math.max(1, Math.min(5, Number(a.aiRetry) || 3));
  let pool = buildTextPool();
  if (pick && pick.provider && pick.model) {
    pool = pool.filter(p => p.provider === pick.provider && p.model === pick.model);
    if (!pool.length) return { ok: false, error: '所选文本模型未配置 Key' };
  }
  if (!pool.length) return { ok: false, error: '未配置文本模型 Key' };
  let lastErr = '未知错误';
  for (const item of pool) {
    for (let i = 1; i <= retry; i++) {
      if (aiAgent.abort) return { ok: false, error: '已停止' };
      const r = await aiTextOnce({ key: item.key, base: item.base, model: item.model }, system, user);
      if (r.ok) return Object.assign(r, { used: item.tag + ' ' + item.model });
      lastErr = r.error;
      if (i < retry) await sleep(1500);
    }
  }
  return { ok: false, error: '全部文本模型调用失败：' + lastErr };
}
// AI 决策循环：每轮截图→模型出动作→执行→再截图
async function aiAgentLoop(cfg) {
  const game = readGames().find(g => g.id === auto.gameId);
  const rules = String((game && game.rules) || '').trim();
  const goal = String((cfg && cfg.text) || '').trim();
  // 单次任务检测：指令含「一次/一下/点一下/单击」等且非持续类 → 执行完第一次点击即强制停止
  const oneShot = (/一次|一下|单击|点一下|按一下|点一次|按一次|点这个|点那个/.test(goal)) && !(/一直|持续|循环|不断|自动过关|通关|重复|连续|多(次|下)/.test(goal));
  // 面板可选模型：形如 "zhipu:glm-4.6v-flash"，'auto'/空 = 走自动降级链路
  const parsePick = (id) => {
    const s = String(id || '').trim();
    if (!s || s === 'auto') return null;
    const idx = s.indexOf(':');
    if (idx < 0) return null;
    return { provider: s.slice(0, idx), model: s.slice(idx + 1) };
  };
  const visionPick = parsePick((cfg && cfg.visionModel) || (cfg && cfg.model)); // 兼容旧的 cfg.model
  const textPick = parsePick(cfg && cfg.textModel);
  aiAgent.playing = true;
  aiAgent.abort = false;
  aiAgent.note = '';
  traceStart(auto.gameId, goal, cfg); // 开启本轮 trace 会话（一次 aiAgent:start = 一个会话目录）
  // 每次启动新一轮清空上一轮的排除记录（换局/换关后旧答案可能重新有效）
  doneClaims = 0;
  lastTapFeedback = '';
  tapHistory = [];
  levelCount = 0;
  let plan = '';
  // 启动前用文本模型做一次策略规划（失败不阻塞，继续用视觉流程）
  try {
    setStatus('AI 正在用文本模型规划策略…', { aiPlaying: true });
    const pr = await aiTextAsk(
      '你是H5小游戏攻略助手。根据任务和游戏规则，给出简洁、可执行的策略要点（最多3条，纯文本，不要JSON）。',
      '任务：' + (goal || '自动游玩并尽量通关') + (rules ? '\n游戏规则：' + rules : '') + '\n请给出策略要点。',
      textPick
    );
    if (pr.ok) { plan = String(pr.text).replace(/\s+/g, ' ').slice(0, 400); setStatus('策略规划（' + pr.used + '）：' + plan, { aiPlaying: true }); }
    else if (!aiAgent.abort && pr.error !== '已停止') setStatus('策略规划失败（' + pr.error + '），直接开始视觉决策', { aiPlaying: true });
  } catch (e) { /* 规划失败不影响主流程 */ }
  if (aiAgent.abort) { aiAgent.playing = false; setStatus('AI 智能决策已停止', { aiPlaying: false }); return; }
  const system =
    '你是H5小游戏自动操作员。你会收到当前游戏窗口的完整截图，坐标用 0~1 相对比例表示：x=0 是画面最左边、x=1 是最右边；y=0 是最上边、y=1 是最下边。' +
    '定位方法（重要，请严格照做以对准小目标）：先在心里把画面横向切成 10 等份、纵向切成 10 等份，估出目标中心点落在第几份，再写成 0.05 精度的小数（如第 3 份中间 ≈ 0.25）；' +
    '计算格子类目标（键盘、选项、九宫格）时，用公式：x = (列号 - 0.5) / 总列数，y = (行号 - 0.5) / 总行数；' +
    '例如 6 列键盘第 5 格 → x = (5-0.5)/6 ≈ 0.75，而不是 0.65。务必用"格子的中心"而不是格子左边缘来算，否则会系统性偏左并点到相邻格；' +
    '对于并排的按钮/按键（如数字键盘），务必确认目标是在第几个格子，左右相邻按钮中心通常只差 0.1 左右，看错一格就会点偏邻键；宁可多看一秒，不要点错目标。' +
    'reasoning 里先说明「目标在画面中的位置描述」，再给出 tap 坐标。' +
    (rules ? '\n[游戏规则]\n' + rules : '') +
    (plan ? '\n[策略规划]\n' + plan : '') +
    '\n[当前任务]\n' + (goal || '自动游玩并尽量通关') +
    (oneShot ? '\n[任务类型：单次动作] 只需找到目标执行1次tap后必须done=true立即停止。绝不要重复点击同一目标——即使画面看似没变化，你的点击也已生效（画面稳定是正常的），不要因此重复点击；宁可输出wait也不要多点。' : '') +
    '\n每轮我会发一张当前游戏截图。你看画面判断并输出下一步，只输出一个JSON：' +
    '{"reasoning":"你看到的画面一句话","actions":[{"type":"tap","box":[左,上,右,下],"label":"目标名称"}|{"type":"wait","ms":500}|{"type":"restart"}],"done":false}。' +
    '\n【点哪里——用边界框 box（重要，这决定了点击精度）】' +
    '不要直接给一个点，而是给出目标物体在画面中的矩形范围 box=[左,上,右,下]，四个数都是相对整张截图的 0~1 比例' +
    '（x：0=最左、1=最右；y：0=最上、1=最下）。程序会自动取这个框的正中心去点。' +
    '为什么用框：判断"这个按钮的左右边在哪、上下边在哪"比凭空估中心更准，取四边中点还能自动抵消单边误差。' +
    '要求：框要贴合目标本身的边缘（例如一个按键就框住这个按键的整个方块，不要包含相邻按键，也不要只框住里面的字）。' +
    '务必用 0~1 的小数表示（如 0.35），不要用像素数字（如 320）——四个数都必须 ≤ 1。' +
    '例：要点下方 4 列字块中最左边那个，它的框约 box=[0.11,0.70,0.31,0.77]，中心就落在约 (0.21,0.735)。' +
    '纯点击、没有具体目标形状时（比如点空白处），也可以用旧的 {"type":"tap","x":0~1,"y":0~1}。' +
    '\n约束：一次最多3个动作；box 里四个数都必须在 0~1；wait用于等待动画/加载/画面变化；restart表示重新开始本局。' +
    '何时done=true停止：①任务是某个具体单次动作（如“点数字3”“按开始按钮”“点击那个图标”）——只找该目标并点击一次，完成后立即done=true，绝不点击目标以外的任何无关元素，宁可wait也不要乱点；②持续类任务（如“自动过关”“一直点某处”“循环游玩”）——仅在已通关或确定无法继续时done=true。' +
    '\n【关于过关】当游戏真的进入下一关/显示成功时，输出 done=true；系统会自动进入下一关继续。' +
    '禁止输出JSON以外的任何文字。';
  let history = [];
  let stuck = 0;      // 画面连续无变化轮数
  let lastSig = null;
  let badRounds = 0;  // 连续未返回有效动作的轮数（防死循环）
  const MAX_BAD = 8;
  setStatus('AI 智能决策开始' + (rules ? '（已加载游戏规则）' : '（未填游戏规则，建议在游戏库编辑里填写）') + '：' + (goal || '自动游玩'), { aiPlaying: true });
  try {
    while (aiAgent.playing && !aiAgent.abort) {
      if (!gameWin || gameWin.isDestroyed()) { setStatus('游戏窗口已关闭，AI 停止', { aiPlaying: false }); aiAgent.playing = false; break; }
      // 本轮 trace 记录（截图/画面判断/模型返回/动作/点击结果），轮末统一落盘
      const roundRec = { jpg: null, imgW: 0, imgH: 0, hint: '', seen: '', model: '', raw: '', actions: [], taps: [], verdict: '' };
      const page = await gameWin.webContents.capturePage();
      // 等比缩放（不能强制拉伸成固定宽高）：否则画面变形，模型按变形图估的坐标换算回原图会左右偏移
      const rawSz = page.getSize();
      // 截图清晰度（方案E）：默认宽度上限 720。若配置里开了"高清截图"，则用原始 Retina 分辨率
      // （实测对本游戏精度提升很小、但 token 增加约 55%，故做成可选，默认关）
      const hiRes = !!(auto.options && auto.options.aiHiRes);
      const capW = hiRes ? Math.max(720, rawSz.width || 720) : Math.min(720, rawSz.width || 720);
      const scale = rawSz.width > 0 ? capW / rawSz.width : 1;
      const small = page.resize({ width: capW, height: Math.max(1, Math.round(rawSz.height * scale)) });
      const jpgBuf = small.toJPEG(80);
      const b64 = jpgBuf.toString('base64');
      roundRec.jpg = jpgBuf; // trace：本轮发给模型的那张图（原样留存）
      // 记录本轮发给模型的图片尺寸：若模型误用像素坐标描述 box，可按此换算回 0~1
      aiAgent.lastImgW = small.getSize().width;
      aiAgent.lastImgH = small.getSize().height;
      roundRec.imgW = aiAgent.lastImgW;
      roundRec.imgH = aiAgent.lastImgH;
      // 记录页面可见内容区尺寸（clientWidth/Height 不含滚动条）：
      // 若网页有滚动条，getContentSize 会比可见区大，用它换算会点偏；这里以真实可见区为准。
      try {
        const vp = await gameWin.webContents.executeJavaScript('({w: document.documentElement.clientWidth, h: document.documentElement.clientHeight})');
        if (vp && vp.w > 0 && vp.h > 0) { aiAgent.pageW = vp.w; aiAgent.pageH = vp.h; }
      } catch (e) {}
      // 卡住提示：连续多轮画面几乎没变 → 告诉模型换策略（单次任务不发，避免误导重复点击已生效的目标）
      // 签名复用本轮已截的图，避免再截一次（省时且保证和发给模型的是同一帧）
      let hint = '';
      // 上一轮点击若判定为"可能没点中"，本轮先把这条反馈塞给模型，让它重新定位
      if (lastTapFeedback) { hint = lastTapFeedback; lastTapFeedback = ''; }
      if (!oneShot) {
        const sig = signatureOf(page);
        if (lastSig && sig) {
          const sim = similarity(lastSig, sig);
          // 本轮画面相比上一轮几乎没变 → 累计卡住轮数
          if (sim > STUCK_SIM) { stuck++; if (stuck >= 3) hint += '（提示：画面已连续' + stuck + '轮无明显变化，可能卡住了，请换策略、等待或 restart）'; }
          else stuck = 0;
        }
        lastSig = sig;
      }
      let askText = '请看当前游戏画面';
      if (hint) askText += hint;
      roundRec.hint = hint; // trace：本轮塞给模型的提示（卡住/上次点击没变化/过关复核等）
      const res = await aiVisionAsk(b64, system, history, askText, visionPick);
      roundRec.model = res && res.used ? res.used : ''; // trace：实际用的模型（自动降级时记录具体哪家）
      roundRec.raw = String((res && res.text) || '');   // trace：模型原始返回（含推理文本，便于诊断格式问题）
      if (aiAgent.abort) break; // 等待模型期间用户点了停止 → 立即退出，不再执行后续动作
      if (!res.ok) {
        roundRec.verdict = 'api-fail:' + String(res.error || '').slice(0, 120); // trace：模型调用失败也留档（含截图，便于看当时画面）
        traceRound(roundRec);
        if (aiAgent.abort || res.error === '已停止') break;
        // aiVisionAsk 内部已完成重试与退避等待；这里只做极短暂停顿就进入下一轮，避免双重等待白等几秒
        setStatus('视觉决策失败：' + res.error + '（马上重试）', { aiPlaying: true });
        await sleep(600);
        continue;
      }
      const act = extractJson(res.text);
      if (!act || !Array.isArray(act.actions) || !act.actions.length) {
        badRounds++;
        let why = diagnoseBadAction(res.text, act);
        if (res.truncated) why = '输出被长度上限截断，未生成完整 JSON（模型输出过长，可换非推理模型）｜' + why;
        console.log('[ai-bad] 第' + badRounds + '次无效动作 | 原因: ' + why + ' | 原始返回: ' + String(res.text || '').slice(0, 300));
        roundRec.verdict = 'invalid:' + why; // trace：无效动作也留档
        traceRound(roundRec);
        if (badRounds >= MAX_BAD) {
          setStatus('模型连续 ' + badRounds + ' 轮未返回有效动作，已自动停止。最后原因：' + why + '（可换个模型或调整指令后重试）', { aiPlaying: false });
          aiAgent.playing = false;
          break;
        }
        setStatus('模型未返回有效动作（' + (res.used || '视觉模型') + '，' + badRounds + '/' + MAX_BAD + '）：' + why, { aiPlaying: true });
        await sleep(1000); // 格式没解析对，稍等即可重发，无需长等
        continue;
      }
      badRounds = 0;
      const who = res.used || '视觉模型';
      aiAgent.note = String(act.reasoning || act.note || '');
      roundRec.seen = aiAgent.note; // trace：模型对画面的判断
      roundRec.actions = act.actions.slice(0, 3); // trace：本轮动作（含 box 坐标）
      roundRec.done = !!act.done; // trace：模型是否自称通关
      setStatus('AI 看到：' + (aiAgent.note || '') + '（' + who + '）', { aiPlaying: true });
      let tapped = false;
      // 记录本轮实际做过的点击（用于下一轮告诉模型"你刚才点了哪里、有没有生效"）
      const doneTaps = [];
      for (const ac of act.actions.slice(0, 3)) {
        if (aiAgent.abort) break;
        if (ac.type === 'tap') {
          // 每次点击前都【即时】截当前帧作基准（不用本轮开头可能已过期的 page），
          // 并稍等一帧让上一动作的渲染稳定，避免把上一次动作的变化算到这一次头上
          await sleep(120);
          let before = page;
          if (gameWin && !gameWin.isDestroyed()) {
            try { before = await gameWin.webContents.capturePage(); } catch (e) { before = page; }
          }
          const pt = actionXY(ac);
          const okTap = await doTap(pt.x, pt.y);
          const posDesc = (pt.via === 'box' && Array.isArray(ac.box))
            ? ('「' + (ac.label || '目标') + '」框中心(' + pt.x + ',' + pt.y + ')')
            : ('(' + pt.x + ',' + pt.y + ')');
          if (!okTap) {
            roundRec.taps.push({ x: pt.x, y: pt.y, box: ac.box || null, label: ac.label || '', okTap: false });
            setStatus('模型给出非法坐标 ' + posDesc + '，已跳过本次点击', { aiPlaying: true });
          }
          else {
            // 点击后校验：等画面响应后重新截图，与点击前比对判断这次点击是否真的生效
            const changed = await waitScreenChange(before, 2600);
            doneTaps.push({ x: pt.x, y: pt.y, changed });
            roundRec.taps.push({ x: pt.x, y: pt.y, via: pt.via || '', box: ac.box || null, label: ac.label || '', changed, okTap: true });
            if (!changed) setStatus('点击 ' + posDesc + ' 后画面无视觉变化（可能点空/等输入/无需变化）', { aiPlaying: true });
          }
          if (okTap && oneShot) { tapped = true; break; } // 单次任务：点完即停，不再执行后续动作
        }
        else if (ac.type === 'wait') { await sleep(Math.max(200, Number(ac.ms) || 500)); }
        else if (ac.type === 'restart') { if (gameWin && !gameWin.isDestroyed()) gameWin.webContents.reload(); await sleep(1200); }
      }
      if (aiAgent.abort) { roundRec.verdict = 'aborted-mid-actions'; traceRound(roundRec); break; } // 动作执行期间被停止 → 结束主循环
      // 若本轮有点击但画面没变，把这条实测反馈交给下一轮提示词（比让模型自己猜准得多）
      const misses = doneTaps.filter(t => !t.changed);
      if (misses.length) {
        lastTapFeedback = '（实测反馈：上次点击 ' + misses.map(t => '(' + t.x + ',' + t.y + ')').join('、') +
          ' 之后画面没有视觉变化。这不一定是点错位置——也可能是点到空白处、或该操作本就不引起画面变化。' +
          '请先判断：当前画面是否已包含你要的结果（如果已填入/已展开，就别重复点）；' +
          '若目标确实还没响应，请重新仔细观察目标位置，给出更准的坐标。）';
      }
      // 上下文：保留上一轮模型判断 + 最近几轮点击记录，让模型知道自己点过哪里、有没有生效，
      // 避免在同一位置反复点（原来只留一条 assistant，模型完全没有点击历史）
      tapHistory.unshift(doneTaps);
      tapHistory = tapHistory.slice(0, 3); // 最近 3 轮，控制 token
      const flat = [];
      tapHistory.forEach((round, ri) => round.forEach(t => flat.push({ ...t, ago: ri })));
      history = [{ role: 'assistant', content: res.text }];
      if (flat.length) {
        const desc = flat.map(t => '(' + t.x + ',' + t.y + ')' + (t.changed ? '生效' : '无变化') + (t.ago ? '·' + t.ago + '轮前' : '')).join('；');
        history.push({ role: 'user', content: '[近期操作记录] ' + desc + '。若某处已点过且画面无变化，不要在原地重复点击，请重新定位目标。' });
      }
      // 单次任务代码层兜底：执行过一次 tap 即强制停止，不依赖模型 done 判定（模型常不遵守）
      if (oneShot && tapped) {
        roundRec.verdict = 'oneShot-done'; traceRound(roundRec);
        setStatus('AI 完成单次点击：' + String(act.reasoning || goal) + '（已点一次，停止）', { aiPlaying: false }); aiAgent.playing = false; break;
      }
      // 模型自称通关：不轻信。需连续两轮都判断通关才真正停止，避免"把错答案当成已通关"直接结束。
      if (act.done) {
        doneClaims++;
        if (oneShot || doneClaims >= DONE_CONFIRM_ROUNDS) {
          // 二次确认通关：重置计数，进入下一关
          doneClaims = 0;
          tapHistory = [];
          lastSig = null;
          stuck = 0;
          badRounds = 0; // 无效动作计数也重置，避免跨关累积导致误停
          if (oneShot) {
            roundRec.verdict = 'oneShot-done'; traceRound(roundRec);
            setStatus('AI 完成：' + String(act.reasoning || '完成') + '（单次任务结束）', { aiPlaying: false });
            aiAgent.playing = false;
            break;
          }
          // 持续任务：不停止，进入下一关继续（游戏通常会自动进下一关，等画面稳定后再决策）
          roundRec.verdict = 'level-pass-' + levelCount; traceRound(roundRec);
          levelCount++;
          setStatus('✅ 第 ' + levelCount + ' 关通过，继续下一关…', { aiPlaying: true });
          lastTapFeedback = '（刚刚已经通过上一关，现在进入新的一关，请按当前这一关的画面重新分析作答。）';
          await sleep(1800); // 等过关动画/切关完成
          continue;
        }
        // 第一次说 done：只复核，不停止
        roundRec.verdict = 'done-unconfirmed'; traceRound(roundRec);
        lastTapFeedback = '（重要：你上一轮说已通关。请再确认一次画面是否真的显示通关/成功' +
          '（例如出现下一关、成功提示、进度推进、答案被判定为正确）。' +
          '若只是答案格被填满但游戏并未过关，说明答案是错的，请删掉并换一个全新的答案。' +
          '如果确实已通关，请再次输出 done=true。';
        setStatus('模型判断已通关，正在复核（' + doneClaims + '/' + DONE_CONFIRM_ROUNDS + '）…', { aiPlaying: true });
        continue;
      }
      doneClaims = 0; // 本轮没声称通关，清零
      roundRec.verdict = roundRec.verdict || 'normal'; // trace：正常轮
      traceRound(roundRec);
    }
  } catch (err) {
    setStatus('AI 智能决策异常：' + String((err && err.message) || err), { aiPlaying: false });
  }
  aiAgent.playing = false;
  traceEnd(aiAgent.abort ? 'stopped' : 'ended');
  setStatus(aiAgent.abort ? 'AI 智能决策已停止' : 'AI 智能决策结束', { aiPlaying: false });
}
ipcMain.on('aiAgent:start', (e, cfg) => {
  if (aiAgent.playing) {
    setStatus(aiAgent.abort ? '正在停止上一轮，请稍候再启动' : 'AI 智能决策已在运行，先停止再开始', { aiPlaying: true });
    return;
  }
  if (auto.playing) { setStatus('脚本自动玩正在运行，请先停止', { aiPlaying: true }); return; }
  aiAgentLoop(cfg || {});
});
ipcMain.on('aiAgent:stop', () => { if (aiAgent.playing) { aiAgent.abort = true; setStatus('正在停止 AI 智能决策…', { aiPlaying: true }); } });
ipcMain.handle('aiAgent:state', () => ({ playing: aiAgent.playing, note: aiAgent.note }));
// 决策记录：打开目录 / 查询列表 / 开关
ipcMain.handle('aiTrace:openDir', async () => {
  // shell.openPath 失败时不抛异常，而是返回错误字符串——必须检查，否则会静默失败
  try {
    await fs.promises.mkdir(TRACE_DIR, { recursive: true });
    const err = await shell.openPath(TRACE_DIR);
    if (!err) return { ok: true, opened: TRACE_DIR };
    // 空目录 + 工作区根继承的 Deny ACE 时，Explorer 可能打不开这个子目录；
    // 回退到打开父目录 config（用户可手动点进 ai-trace），并如实回报
    console.log('[ai-trace] openPath 失败：' + err + '，回退打开 config 目录');
    const err2 = await shell.openPath(CONFIG_DIR);
    if (!err2) return { ok: true, opened: CONFIG_DIR, fallback: true, note: '记录目录直接打开失败，已打开配置目录，请手动进入 ai-trace 文件夹：' + err };
    return { ok: false, error: err };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('aiTrace:list', () => {
  const out = [];
  try {
    for (const name of fs.readdirSync(TRACE_DIR)) {
      const dir = path.join(TRACE_DIR, name);
      const file = path.join(dir, 'trace.json');
      if (!fs.existsSync(file)) continue;
      try {
        const t = JSON.parse(fs.readFileSync(file, 'utf8'));
        out.push({ id: t.id, startedAt: t.startedAt || 0, endAt: t.endAt || 0, goal: t.goal || '',
                   rounds: (t.rounds || []).length, end: t.end || '', dir });
      } catch (e) {}
    }
  } catch (e) {}
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 30);
});
ipcMain.handle('aiTrace:enabled', () => traceEnabled());
ipcMain.handle('aiTrace:setEnabled', (e, on) => {
  if (!clientConfig) clientConfig = loadClientConfig();
  if (!clientConfig.aiChat) clientConfig.aiChat = {};
  clientConfig.aiChat.aiTrace = !!on;
  writeClientConfigFile();
  return { ok: true, enabled: !!on };
});
// 列出可选模型：auto(自动降级) + 各已配置 Key 的具体模型，文本/视觉分开返回
ipcMain.handle('aiAgent:models', () => {
  const build = (pool, autoLabel) => {
    const items = [{ id: 'auto', label: autoLabel }];
    pool.forEach(p => items.push({ id: p.provider + ':' + p.model, label: p.tag + ' ' + p.model }));
    return { items, default: 'auto' };
  };
  const out = {
    vision: build(buildVisionPool(), '自动（按顺序降级）'),
    text: build(buildTextPool(), '自动（按顺序降级）')
  };
  console.log('[ai-models] 视觉可选: ' + out.vision.items.map(i => i.label).join(' | '));
  console.log('[ai-models] 文本可选: ' + out.text.items.map(i => i.label).join(' | '));
  return out;
});
// ---------- 模型配置（独立管理页：所有提供商统一为自定义配置） ----------
ipcMain.handle('models:list', () => {
  const a = (clientConfig && clientConfig.aiChat) || {};
  const list = Array.isArray(a.customProviders) ? a.customProviders : [];
  return list.map(cp => ({
    id: cp.id, label: cp.label || cp.id, builtin: false,
    base: cp.base || '', key: cp.key || '',
    textModel: cp.textModel || '', visionModel: cp.visionModel || ''
  }));
});
ipcMain.handle('models:save', (e, p) => {
  if (!p || !p.id) return { ok: false, error: '缺少 Provider ID' };
  const a = (clientConfig && clientConfig.aiChat) || {};
  const list = Array.isArray(a.customProviders) ? a.customProviders.slice() : [];
  const i = list.findIndex(x => x.id === p.id);
  const item = { id: p.id, label: p.label || p.id, base: String(p.base || ''), key: String(p.key || ''), textModel: String(p.textModel || ''), visionModel: String(p.visionModel || '') };
  if (i >= 0) list[i] = item; else list.push(item);
  saveClientConfig({ aiChat: { customProviders: list } });
  return { ok: true };
});
ipcMain.handle('models:delete', (e, id) => {
  const a = (clientConfig && clientConfig.aiChat) || {};
  const list = (Array.isArray(a.customProviders) ? a.customProviders : []).filter(x => x.id !== id);
  saveClientConfig({ aiChat: { customProviders: list } });
  return { ok: true };
});
// 判定模型能力：'text' 纯文本 / 'vision' 纯视觉 / 'both' 两者都能
// 兼容多种接口字段写法：input_modalities / modalities.input / capabilities / architecture.input_modalities，无则用模型名推测
function classifyModelKind(m) {
  const norm = a => (Array.isArray(a) ? a.map(s => String(s).toLowerCase()) : []);
  const inm = norm(
    (m && m.input_modalities) ||
    (m && m.modalities && m.modalities.input) ||
    (m && m.architecture && m.architecture.input_modalities) ||
    (m && m.capabilities)
  );
  if (inm.length) {
    const canImage = inm.includes('image') || inm.includes('vision') || inm.includes('video') || inm.includes('multimodal');
    const canText = inm.includes('text');
    if (canImage && canText) return 'both';
    if (canImage) return 'vision';
    return 'text';
  }
  // 名字兜底：glm-4.6v-flash / *-vl- / Qwen2.5-VL / *-vision / OCR / omni 等判为多模态（通常也能处理纯文本）
  const id = String((m && (m.id || m.name || m.model)) || '').toLowerCase();
  if (/(-v\b|-v-|-vl-|\bvl\b|vision|multimodal|omni|ocr|\d+v\b|[0-9]v[-_]|[0-9]\.?[0-9]?v\b)/i.test(id)) return 'both';
  return 'text';
}
// 判定模型是否免费：'free' 明确免费 / 'paid' 明确收费 / '' 未知
// 依据：接口 pricing 字段优先（各家写法不同，常见 pricing / pricing.prompt+completion）；
//      同时兼容 openrouter 风格的 pricing 字符串键；无价格信息时用名字里的 free 兜底推测
function classifyModelPrice(m) {
  const p = (m && (m.pricing || (m.architecture && m.architecture.pricing))) || null;
  if (p && typeof p === 'object') {
    // 收集所有数值型价格项（单位可能是 $/token 或 $/1M token，只要全是 0 就视为免费）
    const nums = [];
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v === null || v === undefined) continue;
      const n = Number(v);
      if (!Number.isNaN(n) && String(v).trim() !== '') nums.push(n);
      else if (typeof v === 'object') { // 嵌套写法：{prompt:{price:...}}
        for (const k2 of Object.keys(v)) { const n2 = Number(v[k2]); if (!Number.isNaN(n2)) nums.push(n2); }
      }
    }
    if (nums.length) return nums.every(n => n === 0) ? 'free' : 'paid';
  }
  // 无价格信息：名字/display_name 里带 free 的当免费（推测，界面会标注）
  const id = String((m && (m.id || m.name || m.model)) || '').toLowerCase();
  const disp = String((m && (m.display_name || m.magpie_label)) || '').toLowerCase();
  if (/(^|[/_-])free([/_-]|$)|\bfree\b|免费/.test(id) || /免费/.test(disp)) return 'free';
  return '';
}
// 接口是否真的给了价格字段（用于区分"接口明确免费"和"仅按名字推测免费"）
function hasRealPricing(arr) {
  return arr.some(m => {
    const p = m && (m.pricing || (m.architecture && m.architecture.pricing));
    return p && typeof p === 'object' && Object.keys(p).length > 0;
  });
}
// 拉取某提供商的可用模型列表，并区分文本 / 视觉 / 两者皆可，同时标注是否免费
ipcMain.handle('models:fetchList', async (e, p) => {
  const base = String((p && p.base) || '').replace(/\/+$/, '');
  const key = String((p && p.key) || '');
  if (!base) return { ok: false, error: '请先填写 API 地址' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: ac.signal });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (err) {}
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : null);
    if (!arr) return { ok: false, error: r.ok ? '返回格式无法识别（不是 {data:[...]}）' : ('HTTP ' + r.status + ' ' + txt.slice(0, 120)) };
    const items = [];
    let priceKnown = false, freeCount = 0;
    for (const m of arr) {
      const id = m && (m.id || m.name || m.model);
      if (!id) continue;
      const price = classifyModelPrice(m);
      if (price) priceKnown = true;
      if (price === 'free') freeCount++;
      items.push({ id: String(id), kind: classifyModelKind(m), price });
    }
    // 价格信息来源：'api' 接口明确给出 / 'name' 仅按名字推测 / '' 完全未知
    const priceFrom = items.some(x => x.price) ? (hasRealPricing(arr) ? 'api' : 'name') : '';
    return { ok: true, items, priceFrom, freeCount, total: items.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally { clearTimeout(timer); }
});
// 打开模型配置文件（模型配置页右上角按钮）—— 现在指向独立的 models.json
ipcMain.handle('models:openConfig', async () => { try { await shell.openPath(MODELS_PATH); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } });
// ---------- 弹幕自动回复（非官方：浏览器自动化抓直播间） ----------
// 采集器在 src/preload-danmaku.js：document-start 自动注入、只观察聊天容器、推模式上报、带健康检查与自愈。
// 主进程这里只负责：窗口生命周期、把采集器/探针的消息转发给主界面、以及「阶段0」WS 探针。
let danmakuWin = null;
let dmProbeTimer = null;
let dmProbeState = null;
let dmConnectSeq = 0; // 连接代次：异步解析短链期间用户点了「断开」就不要再开窗口

let lastDmStatus = ''; // 去重：连续相同状态只发一次（避免 did-start-loading 重复刷屏）
function clipStr(s, n) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t; }
function sendDmStatus(msg) {
  if (msg === lastDmStatus) return;
  lastDmStatus = msg;
  if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send('dm:status', msg);
}
function toLibrary(channel, payload) {
  if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send(channel, payload);
}
// 明确的连接状态（驱动界面上「连接/断开」切换按钮）。
// 不能用 connectDanmaku() 的返回来判断：它只代表「发起连接」，页面真正加载完成才算连上。
// 三态：connected(页面加载完成) / disconnected(断开或窗口关闭) / failed(从未加载成功)
function sendDmState(state) { toLibrary('dm:state', { state: state }); }
// 确认事件确实来自当前弹幕窗口（避免别的窗口伪造）
function isDanmakuSender(e) {
  return !!(danmakuWin && !danmakuWin.isDestroyed() && e.sender === danmakuWin.webContents);
}

// ---------- 统一转发 + 跨源去重 ----------
// 同一条弹幕会同时从「DOM 采集器」和「WS 解码」到达，在 danmaku-dedupe 里合流：
// WS 优先（结构化字段更全），WS 断流 8 秒后 DOM 自动接管。
const dmDedupe = require('./danmaku-dedupe');
dmDedupe.init(toLibrary);

// 采集器（preload，推模式）→ 主界面渲染进程
ipcMain.on('dm:message', (e, msg) => {
  if (!isDanmakuSender(e)) return;
  dmDedupe.forward(msg, 'dom');
});
ipcMain.on('dm:health', (e, h) => {
  if (!isDanmakuSender(e)) return;
  console.log('[dm-health] ' + JSON.stringify(h || {}));
  toLibrary('dm:health', h || {});
});

// ---------- CDP 旁观 WebSocket 推送帧 ----------
// 旁听页面自己已建立的 WSS：签名 / a_bogus / 心跳 / ACK 全由页面 JS 完成，这里只读帧、不解码发送、不发业务请求。
// 二进制帧（opcode!=1）的 payloadData 是 base64 → PushFrame → (gzip) → Response.messagesList → protobuf 解码。
// 解出的结构化事件与 DOM 采集器在 danmaku-dedupe 处合流去重；解码失败静默回退 DOM，绝不影响现有功能。
// 可用 config/client-config.json 的 danmaku.probe=false 关闭整个旁听（含解码）。
function probeEnabled() {
  try {
    const d = clientConfig && clientConfig.danmaku;
    return !d || d.probe !== false;
  } catch (e) { return true; }
}
function pushSocketUrl(u) { return /webcast|\/im\/(push|fetch)/i.test(String(u || '')); }

// base64（CDP 二进制帧）→ Message[]。两种解码尝试，失败返回空数组，绝不抛。
function decodeFramePayload(data) {
  const s = String(data || '');
  if (!s) return [];
  const candidates = [];
  try { candidates.push(Buffer.from(s, 'base64')); } catch (e) {}
  try { candidates.push(Buffer.from(s, 'binary')); } catch (e) {}
  for (const b of candidates) {
    if (!b.length) continue;
    try {
      const msgs = dmProto.decodePushFrame(b);
      if (msgs.length) return msgs;
    } catch (e) {}
  }
  return [];
}

// 帧样本落盘：把前若干帧的真实结构写到 config/dm-frame-sample.txt，
// 用来反推抖音当前的真实封装（本地无需抓包，直接看文件）。
const dmFrameSamples = [];
let dmFrameDumped = false;
function dumpFrameSample(data) {
  if (dmFrameSamples.length >= 6) return;
  try {
    const b = Buffer.from(String(data || ''), 'base64');
    if (!b.length) return;
    const info = dmProto.analyzeFrame(b);
    // 额外留一段原始 hex（前 96 字节）便于人工比对
    info.rawHex96 = b.subarray(0, 96).toString('hex');
    dmFrameSamples.push(info);
    if (dmFrameSamples.length >= 6 && !dmFrameDumped) {
      dmFrameDumped = true;
      const out = {
        at: new Date().toISOString(),
        note: '抖音 WS 推送帧样本（前6帧）。analyzFrame 各字段含义见 danmaku-proto.js',
        samples: dmFrameSamples
      };
      const file = path.join(ROOT, 'config', 'dm-frame-sample.json');
      try { fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8'); } catch (e) {}
      console.log('[dm-frame-sample] 已写入 ' + file);
      console.log('[dm-frame-sample] ' + JSON.stringify(out.samples[0]));
    }
  } catch (e) {}
}

// 未解帧样本：抓到「有推送帧但拆不出任何消息」时单独落盘，用来确认是心跳/控制帧还是格式不识别
const dmUnparsedSamples = [];
let dmUnparsedDumped = false;
function dumpUnparsedFrame(data) {
  if (dmUnparsedSamples.length >= 8) return;
  try {
    const b = Buffer.from(String(data || ''), 'base64');
    if (!b.length) return;
    const info = dmProto.analyzeFrame(b);
    info.rawHex96 = b.subarray(0, 96).toString('hex');
    dmUnparsedSamples.push(info);
    if (dmUnparsedSamples.length >= 8 && !dmUnparsedDumped) {
      dmUnparsedDumped = true;
      const out = { at: new Date().toISOString(), note: '未解帧样本（前8个）。label=control/heartbeat 表示是心跳/ACK 控制帧，非弹幕', samples: dmUnparsedSamples };
      try { fs.writeFileSync(path.join(ROOT, 'config', 'dm-frame-unparsed.json'), JSON.stringify(out, null, 2), 'utf8'); } catch (e) {}
      console.log('[dm-unparsed] 已写入 config/dm-frame-unparsed.json；样本0=' + JSON.stringify(dmUnparsedSamples[0]));
    }
  } catch (e) {}
}

function startDanmakuProbe(win) {
  stopDanmakuProbe();
  if (!probeEnabled()) {
    sendDmStatus('WS 探针已关闭（client-config.json → danmaku.probe=false）');
    return Promise.resolve();
  }
  const st = {
    attached: false, created: 0, handshake: 0, pushSockets: 0,
    frames: 0, binaryFrames: 0, pushFrames: 0, bytes: 0,
    decoded: 0, unparsed: 0, errors: 0, dropped: 0,
    byKind: { chat: 0, gift: 0, like: 0, enter: 0, follow: 0 },
    error: ''
  };
  dmProbeState = st;
  const dbg = win.webContents.debugger;
  const pushIds = new Set();
  let firstPushReported = false;
  let loggedErrors = 0;

  const emit = (tag) => {
    st.dropped = dmDedupe.droppedCount();
    const payload = Object.assign({}, st, { byKind: Object.assign({}, st.byKind), ts: Date.now(), tag: tag || '' });
    console.log('[dm-probe] ' + JSON.stringify(payload));
    toLibrary('dm:probe', payload);
  };

  const setup = (async () => {
    try {
      if (!dbg.isAttached()) await dbg.attach('1.3');
      await dbg.sendCommand('Network.enable'); // 必须，否则不产生 WebSocket 事件
      st.attached = true;
    } catch (err) {
      st.error = String((err && err.message) || err);
      console.log('[dm-probe] attach/enable 失败：' + st.error);
    }
    dbg.on('detach', () => { st.attached = false; });
    dbg.on('message', (_e, method, p) => {
      const q = p || {};
      if (method === 'Network.webSocketCreated') {
        st.created++;
        if (pushSocketUrl(q.url)) { pushIds.add(q.requestId); st.pushSockets = pushIds.size; }
      } else if (method === 'Network.webSocketHandshakeResponseReceived') {
        st.handshake++;
      } else if (method === 'Network.webSocketFrameReceived') {
        st.frames++;
        const r = q.response || {};
        if (r.opcode !== 1) st.binaryFrames++; // opcode!=1 → payloadData 是 base64 二进制
        st.bytes += String(r.payloadData || '').length;
        if (pushIds.has(q.requestId)) {
          st.pushFrames++;
          if (!firstPushReported) { firstPushReported = true; emit('first-push-frame'); }
          // 只解二进制帧；文本帧（心跳/ack 等）跳过
          if (r.opcode !== 1) {
            dumpFrameSample(r.payloadData); // 前 6 帧落盘，用于反推真实封装
            try {
              const msgs = decodeFramePayload(r.payloadData);
              if (!msgs.length) { st.unparsed++; dumpUnparsedFrame(r.payloadData); } // 有推送帧但拆不出 Message
              for (const m of msgs) {
                const ev = dmProto.decodeMessage(m);
                if (!ev) continue;
                st.decoded++;
                dmDedupe.markWsActive();
                if (Object.prototype.hasOwnProperty.call(st.byKind, ev.kind)) st.byKind[ev.kind]++;
                dmDedupe.forward(ev, 'ws');
              }
            } catch (err) {
              st.errors++;
              if (++loggedErrors <= 5) console.log('[dm-decode] 帧解码异常：' + String((err && err.message) || err));
            }
          }
        }
      } else if (method === 'Network.webSocketClosed') {
        pushIds.delete(q.requestId);
        st.pushSockets = pushIds.size;
      }
    });
    emit('start');
    dmProbeTimer = setInterval(() => emit('tick'), 2500);
  })();

  // 不让探针卡住页面加载：最多等 2.5 秒
  return Promise.race([
    setup.catch(() => {}),
    new Promise(r => setTimeout(r, 2500))
  ]);
}
function stopDanmakuProbe() {
  if (dmProbeTimer) { clearInterval(dmProbeTimer); dmProbeTimer = null; }
  dmProbeState = null;
}

// ---------- 弹幕源窗口 ----------
// 抖音短链（v.douyin.com/xxx）的落地页常带 CSP，JS 跳转会被 Chromium 判为
// navigate-to 违规 → ERR_BLOCKED_BY_CSP(-30)。直接用落地页跳转后的真实直播间地址可绕开。
// 注意：Node fetch 不带浏览器登录 Cookie，所以只接受解析到 live.douyin.com 的结果；
// 其余情况一律沿用原地址，交给带 persist:douyin Cookie 的窗口自己跳转。
const DM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function isShortLink(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === 'v.douyin.com' || h === 'www.v.douyin.com' || h === 'vmobile.douyin.com';
  } catch (e) { return false; }
}
async function resolveShortLink(u) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    let r;
    try {
      r = await fetch(u, { redirect: 'follow', signal: ac.signal,
        headers: { 'User-Agent': DM_UA, 'Accept': 'text/html,*/*' } });
    } finally { clearTimeout(timer); }
    const final = String(r && r.url || '');
    if (/^https?:\/\/(?:www\.)?live\.douyin\.com\//i.test(final) && final !== u) {
      console.log('[dm-resolve] ' + u + ' -> ' + final);
      return final;
    }
    console.log('[dm-resolve] 未解析到直播间地址（' + (final || '无') + '），沿用原地址由窗口自行跳转');
  } catch (e) {
    console.log('[dm-resolve] 短链解析失败，沿用原地址：' + String((e && e.message) || e));
  }
  return u;
}

// ---------- 直播间连接历史（config/dm-history.json） ----------
// 结构：[{ url, name, ts }]，按最近连接时间倒序，最多 10 条
const DM_HISTORY_FILE = path.join(CONFIG_DIR, 'dm-history.json');
function readDmHistory() {
  try { const v = JSON.parse(fs.readFileSync(DM_HISTORY_FILE, 'utf8')); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function writeDmHistory(list) {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(DM_HISTORY_FILE, JSON.stringify(list.slice(0, 10), null, 2), 'utf8'); } catch (e) {}
}
// 记录一次成功连接：更新或新增条目，置顶，并推送最新列表给界面
function pushDmHistory(url, name) {
  if (!url || !/^https?:\/\//.test(url)) return;
  const list = readDmHistory();
  const old = list.find(x => x.url === url);
  const entry = { url, name: name || (old && old.name) || '', ts: Date.now() };
  const rest = list.filter(x => x.url !== url);
  writeDmHistory([entry, ...rest]);
  toLibrary('dm:historyUpdated', readDmHistory());
}
// 从直播间页面提取主播名。页面有两种形态：
// ① webcast.amemv.com/douyin/webcast/reflow（v.douyin.com 短链目标）：title 是「抖音」，
//    但首屏 SSR 数据有 "nickname":"xxx"（owner 在最前）、还有
//    <input name="shareTitle" value="大肥鱼的直播"> —— 服务器下发，最可靠
// ② live.douyin.com 直连页：DOM 有主播昵称节点，但页面上「我的喜欢」等入口文本
//    也会被宽松选择器误抓 → DOM 候选必须与 SSR/分享标题/页面标题交叉验证才接受
// 验证过的实测案例：v.douyin.com/g4oJbpBwKls/ → 主播「大肥鱼」
async function extractAnchorName(wc) {
  try {
    const script = '(' + function () {
      function clean(s) {
        s = String(s || '').trim();
        if (!s || s === '抖音' || s === '抖音直播') return '';
        // 剥掉标题里的站点/房间后缀：「大肥鱼的抖音直播间 - 抖音直播」→「大肥鱼」
        // 顺序重要：先删「正在直播…」，否则「直播间?$」的可选匹配会把「正在直播」里的「直播」误删
        s = s.replace(/\s*[-–—].*$/, '').replace(/正在直播.*$/, '').replace(/的?(抖音)?直播间?$/, '').trim();
        if (!s || s === '抖音' || s === '抖音直播') return '';
        return s.slice(0, 40);
      }
      // ① SSR 初始数据：第一个非空 nickname 即主播（reflow 页 owner 排在 user/访客之前）
      var html = document.documentElement.innerHTML;
      var re = /"nickname"\s*:\s*"((?:[^"\\]|\\.)*)"/g, m, ssr = '';
      while ((m = re.exec(html)) !== null) {
        var v = m[1];
        try { if (v.indexOf('\\') >= 0) v = JSON.parse('"' + v + '"'); } catch (e) {}
        v = clean(v);
        if (v) { ssr = v; break; }
      }
      // ② 分享标题字段（reflow 页）：<input name="shareTitle" value="大肥鱼的直播">
      var st = document.querySelector('input[name="shareTitle"]');
      var share = clean(st && st.value);
      if (ssr) return ssr;
      if (share) return share;
      // ③ live 直连页：页面标题（「大肥鱼的直播间 - 抖音直播」）比宽松 DOM 选择器可靠
      var titleCand = clean(document.title);
      if (titleCand) return titleCand;
      // ④ 最后手段：DOM 昵称节点（无 SSR/分享/标题凭据时才用，可能误抓页面入口文本）
      var sels = ['.webcast-anchor-nickname', '#living-anchor-info-nick', '[data-e2e="anchor-info"] [class*="nick"]', '#header [class*="nick"]'];
      for (var j = 0; j < sels.length; j++) {
        try {
          var el = document.querySelector(sels[j]);
          var t = clean(el && el.textContent);
          if (t) return t;
        } catch (e) {}
      }
      return '';
    }.toString() + ')()';
    return String(await wc.executeJavaScript(script, true) || '').trim();
  } catch (e) { return ''; }
}

async function connectDanmaku(url) {
  const seq = ++dmConnectSeq;
  disconnectDanmaku();
  dmDedupe.reset(); // 重新连接时清空跨源去重池与源状态
  if (!/^https?:\/\//.test(url)) return;
  sendDmStatus('正在打开直播间页面…');

  // 短链先解析成真实直播间地址，避开落地页 CSP
  let target = url;
  if (isShortLink(url)) {
    sendDmStatus('正在解析直播间短链（避免跳转页 CSP 拦截）…');
    target = await resolveShortLink(url);
  }
  if (seq !== dmConnectSeq) return; // 解析期间已断开，别再开窗口

  const win = new BrowserWindow({
    width: 1080, height: 760, show: false,
    backgroundColor: '#0f1020', title: '弹幕源（直播间）',
    webPreferences: {
      preload: path.join(DATA_DIR, 'preload-danmaku.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:douyin',
      backgroundThrottling: false // 隐藏窗口默认会被节流，聊天虚拟列表可能不渲染 → 必开
    }
  });
  danmakuWin = win;
  win.setMenuBarVisibility(false);
  const wc = win.webContents;
  wc.setAudioMuted(true);
  let everLoaded = false;
  let finalUrl = target;

  wc.on('did-start-loading', () => sendDmStatus('正在加载直播间页面…'));
  wc.on('did-navigate', (_e, navUrl) => { if (navUrl && navUrl !== 'about:blank') finalUrl = navUrl; });
  wc.on('did-redirect-navigation', (_e, redirectUrl) => { if (redirectUrl) console.log('[dm-redirect] ' + redirectUrl); });
  wc.on('did-fail-load', (_e, code, desc, validatedUrl, isMainFrame) => {
    if (code === -3) return;            // ERR_ABORTED：被后续导航取消，重定向链里很常见
    if (isMainFrame === false) return;  // 子资源 / iframe 失败不影响聊天页
    console.log('[dm-fail-load] code=' + code + ' ' + clipStr(desc, 200) + ' url=' + clipStr(validatedUrl, 200));
    // 已经成功加载过 → 只是后续跳转被拦，页面还在、采集继续，绝不把状态钉死成「已停止」
    if (everLoaded) {
      sendDmStatus('提示：后续跳转被拦截（' + clipStr(desc, 120) + '，code ' + code + '）；当前页面仍在，采集继续。建议改用 live.douyin.com 直链');
    } else {
      sendDmState('failed'); // 从未加载成功 → 按钮恢复「连接直播间」，可重试
      sendDmStatus('页面加载失败：' + clipStr(desc, 120) + '（code ' + code + '）' +
        (isShortLink(url) ? '；短链跳转易被 CSP 拦截，建议改用 live.douyin.com 直链' : ''));
    }
  });
  wc.on('did-finish-load', () => {
    everLoaded = true;
    wc.setAudioMuted(true);
    sendDmState('connected'); // 页面真正加载完成 → 按钮变「断开」
    // 重定向后的 URL 常带一大串参数，只显示前 100 字，完整地址写进控制台日志
    console.log('[dm-loaded] ' + clipStr(finalUrl, 300));
    sendDmStatus('页面加载完成' + (finalUrl !== url ? '（' + clipStr(finalUrl, 100) + '）' : '') + '，弹幕采集器已随文档启动（推模式）…');
    // 延迟提取主播名（4s 首次 + 12s 补捞：reflow 页首屏即有 SSR 数据；live 直连页昵称节点渲染较慢）
    let anchorDone = '';
    const tryExtract = (delay) => setTimeout(async () => {
      if (danmakuWin !== win || win.isDestroyed() || anchorDone) return;
      const name = await extractAnchorName(wc);
      if (name) {
        anchorDone = name;
        pushDmHistory(finalUrl, name);
        toLibrary('dm:anchorName', { url: finalUrl, name });
        sendDmStatus('已连接：' + name + '（' + clipStr(finalUrl, 80) + '）');
        console.log('[dm-anchor] ' + name + ' ← ' + clipStr(finalUrl, 200));
      }
    }, delay);
    tryExtract(4000);
    tryExtract(12000);
  });
  const loadTimeout = setTimeout(() => {
    if (!everLoaded) sendDmStatus('提示：页面加载较慢或未进入直播间，请确认链接是否有效 / 是否已扫码登录');
  }, 20000);
  wc.once('did-finish-load', () => clearTimeout(loadTimeout));
  // 关键：重连时旧窗口的 closed 是「异步」派发的，可能晚于新窗口创建。
  // 若回调无条件把全局 danmakuWin 置 null，会把刚建好的新窗口引用一起清掉 →
  // isDanmakuSender() 永远 false，所有弹幕消息被丢弃（表现为零弹幕）。
  // 因此只在「当前全局仍是自己」时才清理。
  win.on('closed', () => {
    if (danmakuWin === win) {
      danmakuWin = null;
      stopDanmakuProbe();
      sendDmState('disconnected');
    }
  });
  // 窗口被系统/页面自行显示或隐藏时，同步给界面的切换按钮
  win.on('show', () => toLibrary('dm:loginVisible', { visible: true }));
  win.on('hide', () => toLibrary('dm:loginVisible', { visible: false }));

  // 先挂探针（Network.enable 要在导航前生效），再加载页面
  startDanmakuProbe(win).then(() => {
    if (danmakuWin === win && !win.isDestroyed()) wc.loadURL(target);
  });
}
function disconnectDanmaku() {
  stopDanmakuProbe();
  if (danmakuWin && !danmakuWin.isDestroyed()) {
    try {
      const dbg = danmakuWin.webContents.debugger;
      if (dbg.isAttached()) dbg.detach();
    } catch (e) {}
    danmakuWin.destroy();
  }
  danmakuWin = null;
  lastDmStatus = '';
  sendDmState('disconnected'); // 断开 → 按钮恢复「连接直播间」
}

ipcMain.handle('dm:connect', async (e, url) => { await connectDanmaku(String(url || '').trim()); return true; });
// 直播间连接历史（打开设置页时读取）
ipcMain.handle('dm:history', () => readDmHistory());
// 删除单条（按 url）/ 清空全部连接历史
ipcMain.handle('dm:historyDelete', (e, url) => {
  const list = readDmHistory().filter(x => x.url !== url);
  writeDmHistory(list);
  toLibrary('dm:historyUpdated', list);
  return list;
});
ipcMain.handle('dm:historyClear', () => {
  writeDmHistory([]);
  toLibrary('dm:historyUpdated', []);
  return [];
});
// 登录窗口显隐合并为一个切换按钮：一次调用完成切换并返回最新可见状态
ipcMain.handle('dm:loginToggle', () => {
  if (!danmakuWin || danmakuWin.isDestroyed()) return { exists: false, visible: false };
  try {
    if (danmakuWin.isVisible()) { danmakuWin.hide(); }
    else { danmakuWin.show(); danmakuWin.focus(); }
  } catch (e) {}
  const visible = !!(danmakuWin && !danmakuWin.isDestroyed() && danmakuWin.isVisible());
  toLibrary('dm:loginVisible', { visible });
  return { exists: true, visible };
});
ipcMain.handle('dm:disconnect', () => { dmConnectSeq++; disconnectDanmaku(); return true; });
ipcMain.handle('dm:filterRule', () => { createFilterRule(); return true; });
// 自检：注入一条假弹幕走完整链路（去重 → IPC → 渲染列表），用来二分「采集不到」还是「下游不显示」
ipcMain.handle('dm:test', () => {
  const msg = {
    t: '测试观众：这是一条自检弹幕', type: 'chat', kind: 'chat',
    msgId: 'test' + Date.now(), user: '测试观众', text: '这是一条自检弹幕', src: 'test'
  };
  return { ok: dmDedupe.forward(msg, 'test') };
});

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
    const text = pickModelText(msg);
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
