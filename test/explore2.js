// 交互探查：进入萌宠排排排，测试点列/点砖块的效果
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = '/tmp/explore'; fs.mkdirSync(OUT, { recursive: true });

let dbg;
async function click(win, x, y) {
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(120);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
const shot = (win, n) => win.webContents.capturePage().then(i => { fs.writeFileSync(path.join(OUT, n), i.toPNG()); console.log('saved ' + n); });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 414, height: 736, x: 60, y: 40, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false } });
  win.setAlwaysOnTop(true);
  await win.loadURL('http://game.migoup.com/h5/wydgn');
  await sleep(12000);
  dbg = win.webContents.debugger;
  await dbg.attach('1.3');

  // 进入萌宠排排排（y=556）
  await click(win, 207, 556);
  await sleep(8000);
  await shot(win, 'e2_start.png');

  // 测1：直接点第3列（中间列）看是否放砖
  await click(win, 202, 410);
  await sleep(2000);
  await shot(win, 'e2_clickCol.png');

  // 测2：点顶部待放区
  await click(win, 202, 200);
  await sleep(2000);
  await shot(win, 'e2_clickTop.png');

  // 测3：再点一列
  await click(win, 202, 410);
  await sleep(2000);
  await shot(win, 'e2_clickCol2.png');

  app.quit();
});
