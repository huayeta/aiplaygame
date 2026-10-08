const { app, BrowserWindow, ipcMain, nativeImage, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const ROOT = app.getAppPath();
const DATA_DIR = path.join(ROOT, 'src');
const GAMES_FILE = path.join(DATA_DIR, 'games.json');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const TPL_DIR = path.join(ROOT, 'templates');

const GAME_W = 414;
const GAME_H = 736; // 9:16

let libraryWin = null;
let gameWin = null;
let panelWin = null;
let aiassistWin = null;

const auto = {
  gameId: null,
  recording: false,
  playing: false,
  cdpAttached: false,
  script: null,
  lastTapTime: 0,
  abort: false,
  highlight: 0, // 当前正在测试/推进的关（1 基，0=无）
  options: { method: 'cdp', speed: 1, loop: true, threshold: 0.9, autoMark: false, freshStart: false, askEveryStart: true }
};

[ SCRIPTS_DIR, TPL_DIR ].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} });

// ---------- 工具 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function readGames() {
  try { return JSON.parse(fs.readFileSync(GAMES_FILE, 'utf8')); } catch (e) { return []; }
}
function writeGames(list) {
  fs.writeFileSync(GAMES_FILE, JSON.stringify(list, null, 2), 'utf8');
}
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
  libraryWin.on('closed', () => { libraryWin = null; });
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
  const voice = (opts && opts.voice) || 'zh-CN-XiaoxiaoNeural';
  const speed = Number(opts && opts.speed) || 1; // 0.5 ~ 2.0
  const ratePct = Math.max(-50, Math.min(100, Math.round((speed - 1) * 100)));
  const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
  const dir = path.join(VOICE_TMP, String(Date.now()));
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const r = await tts.toFile(dir, text, { rate: rateStr, volume: '+0%', pitch: '+0Hz' });
    return { ok: true, url: pathToFileURL(r.audioFilePath).href };
  } catch (err) {
    return { ok: false, err: String((err && err.message) || err) };
  }
});

ipcMain.handle('ai:pickAudio', async () => {
  const res = await dialog.showOpenDialog(aiassistWin || libraryWin, {
    title: '选择背景音乐', properties: ['openFile'],
    filters: [{ name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// 预留：选择本地 .pth 声音模型（GPT-SoVITS，环境装好后使用）
ipcMain.handle('ai:pickModelPth', async () => {
  const res = await dialog.showOpenDialog(aiassistWin || libraryWin, {
    title: '选择声音模型', properties: ['openFile'],
    filters: [{ name: '声音模型', extensions: ['pth', 'safetensors', 'ckpt'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// ---------- 游戏窗口 + 控制面板 ----------
async function startGame(game) {
  closeGameWindows();
  auto.gameId = game.id;

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
  let fresh = false;
  if (auto.options.freshStart) {
    fresh = true; // 总是重新开始，跳过询问
  } else if (auto.options.askEveryStart) {
    // 每次打开都询问：让用户选择重新开始 or 继续进度
    try {
      const { response } = await dialog.showMessageBox(libraryWin || gameWin, {
        type: 'question',
        title: game.name,
        message: '如何开始游戏？',
        detail: '「重新开始新游戏」会清除该游戏的存档进度（回到第1关）',
        buttons: ['继续上次进度', '重新开始新游戏'],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      });
      fresh = response === 1;
    } catch (e) { fresh = false; }
  }
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
ipcMain.on('option:set', (e, patch) => {
  auto.options = Object.assign(auto.options, patch);
  if ('autoMark' in patch) {
    if (auto.recording) { if (patch.autoMark) startAutoMark(); else stopAutoMark(); }
  }
  // 若勾选「总是重新开始」，自动取消「每次询问」
  if (patch.freshStart === true) auto.options.askEveryStart = false;
  if (patch.askEveryStart === true) auto.options.freshStart = false;
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

// 注入到直播间页：MutationObserver 把新弹幕收集进 window.__dmNew（扩大选择器 + 过滤进场提示）
const dmInject = `(function(){
  if (window.__dmObsInjected) return 'already';
  window.__dmNew = window.__dmNew || [];
  const seen = window.__dmSeen = window.__dmSeen || new Set();
  function clean(t){ return (t||'').replace(/\\s+/g,' ').trim(); }
  function pushLine(el){
    if (!el || el.nodeType !== 1) return;
    const txt = clean(el.innerText);
    if (!txt || txt.length > 120 || seen.has(txt)) return;
    // 只过滤明显的系统公告，保留进场提示与真实发言
    if (/^(欢迎|感谢|主播|直播|本场)/.test(txt)) return;
    seen.add(txt);
    window.__dmNew.push(txt);
  }
  function scanNode(node){
    if (!node || node.nodeType !== 1) return;
    const cls = String(node.className||'');
    if (/chatroom|message|danmaku|comment/i.test(cls)) pushLine(node);
    if (node.querySelectorAll){
      const list = node.querySelectorAll('[class*="chatroom"],[class*="message"],[class*="danmaku"],[class*="comment"]');
      for (let i=0;i<list.length;i++) pushLine(list[i]);
    }
  }
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) scanNode(n);
      if (m.type === 'characterData' && m.target && m.target.parentElement) scanNode(m.target.parentElement);
    }
  });
  try { obs.observe(document.body, {childList:true, subtree:true, characterData:true}); } catch(e){}
  window.__dmObsInjected = true;
  window.__dmScan = setInterval(() => {
    try { document.querySelectorAll('[class*="chatroom"],[class*="danmaku"],[class*="comment"]').forEach(pushLine); } catch(e){}
  }, 1500);
  return 'started';
})()`;
const dmPull = `(()=>{ var a = (window.__dmNew||[]).slice(); window.__dmNew = []; return a; })()`;

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
  danmakuWin.webContents.on('did-start-loading', () => sendDmStatus('正在加载直播间页面…'));
  danmakuWin.webContents.on('did-finish-load', async () => {
    sendDmStatus('页面加载完成，注入弹幕监听…');
    const r = await danmakuWin.webContents.executeJavaScript(dmInject, true).catch(() => 'error');
    sendDmStatus('弹幕监听已注入（' + r + '），开始实时抓取…');
    startDanmaku();
  });
  danmakuWin.loadURL(url);
  danmakuWin.on('closed', () => { danmakuWin = null; stopDanmaku(); });
}
function startDanmaku() {
  stopDanmaku();
  dmTimer = setInterval(async () => {
    if (!danmakuWin || danmakuWin.isDestroyed()) return;
    try {
      const arr = await danmakuWin.webContents.executeJavaScript(dmPull, true);
      if (arr && arr.length && libraryWin && !libraryWin.isDestroyed()) {
        arr.forEach(line => libraryWin.webContents.send('dm:message', line));
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
