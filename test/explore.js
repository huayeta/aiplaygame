// 探查：进入各玩法，截图棋盘，确认结构与可解性
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OUT = '/tmp/explore';
fs.mkdirSync(OUT, { recursive: true });

let dbg;
async function click(win, x, y) {
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(120);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log('saved ' + name);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 414, height: 736, x: 60, y: 40, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false } });
  win.setAlwaysOnTop(true);
  await win.loadURL('http://game.migoup.com/h5/wydgn');
  await sleep(12000);

  dbg = win.webContents.debugger;
  await dbg.attach('1.3');
  await shot(win, 'menu.png');

  // 尝试中间三个玩法按钮（相对坐标转像素：x=207, y 分别）
  const tries = [
    { name: 'p1_556', y: 556 },
    { name: 'p2_600', y: 600 },
    { name: 'p3_640', y: 640 }
  ];
  for (const t of tries) {
    await click(win, 207, t.y);
    await sleep(9000);
    await shot(win, t.name + '.png');
    // 返回：刷新回到主菜单
    await win.loadURL('http://game.migoup.com/h5/wydgn');
    await sleep(12000);
  }

  app.quit();
});
