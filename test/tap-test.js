// 独立验证：软点击 / CDP点击 能否驱动 Unity 游戏（窗口可见+聚焦+先移动）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const METHOD = process.argv[2] || 'soft';
const TARGET_X = 207;
const TARGET_Y = 552; // 橙色按钮中心
const OUT = '/tmp/taptest';
fs.mkdirSync(OUT, { recursive: true });

const tapFn = function (x, y) {
  var c = document.getElementById('unity-canvas') || document.elementFromPoint(x, y);
  function fire(type, Ctor, opts) { try { c.dispatchEvent(new Ctor(type, opts)); } catch (e) {} }
  var base = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, view: window };
  var move = Object.assign({ buttons: 0 }, base);
  var down = Object.assign({ buttons: 1 }, base);
  var up = Object.assign({ buttons: 0 }, base);
  fire('pointermove', PointerEvent, Object.assign({ pointerId: 1, pointerType: 'mouse' }, move));
  fire('mousemove', MouseEvent, move);
  fire('pointerdown', PointerEvent, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, down));
  fire('mousedown', MouseEvent, down);
  fire('pointerup', PointerEvent, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, up));
  fire('mouseup', MouseEvent, up);
  fire('click', MouseEvent, up);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 414, height: 736, x: 100, y: 60, show: true, focusable: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false }
  });
  win.setAlwaysOnTop(true);
  win.focus();
  await win.loadURL('http://game.migoup.com/h5/wydgn');
  await sleep(12000);
  win.focus();

  const before = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, METHOD + '-before.png'), before.toPNG());

  if (METHOD === 'cdp') {
    const dbg = win.webContents.debugger;
    await dbg.attach('1.3');
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: TARGET_X, y: TARGET_Y, button: 'none', buttons: 0 });
    await sleep(200);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: TARGET_X, y: TARGET_Y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(80);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: TARGET_X, y: TARGET_Y, button: 'left', buttons: 0, clickCount: 1 });
  } else {
    await win.webContents.executeJavaScript(`(${tapFn.toString()})(${TARGET_X},${TARGET_Y})`, true);
  }

  await sleep(6000);
  const after = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, METHOD + '-after.png'), after.toPNG());

  const sig = img => {
    const s = img.resize({ width: 20, height: 36 }).toBitmap();
    const n = 20 * 36; const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = (0.299 * s[i*4] + 0.587 * s[i*4+1] + 0.114 * s[i*4+2]) / 255;
    return g;
  };
  const a = sig(before), b = sig(after);
  let sim = 0; for (let i = 0; i < a.length; i++) sim += 1 - Math.abs(a[i] - b[i]); sim /= a.length;
  console.log('METHOD=' + METHOD + ' similarity=' + sim.toFixed(3) + (sim < 0.9 ? ' => 点击生效(画面变化)' : ' => 点击疑似无效(画面未变)'));
  app.quit();
});
