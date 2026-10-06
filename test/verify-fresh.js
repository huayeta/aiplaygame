// 验证：清 IDBFS 后重开是否回到第1关（带保活窗口）
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function enterMode(win) {
  const dbg = win.webContents.debugger;
  try { await dbg.attach('1.3'); } catch (e) {}
  for (const [type, x, y, button, buttons] of [
    ['mouseMoved', 207, 552, 'none', 0],
    ['mousePressed', 207, 552, 'left', 1],
    ['mouseReleased', 207, 552, 'left', 0]
  ]) {
    await sleep(120);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
  }
}
const idbNames = win => win.webContents.executeJavaScript(`indexedDB.databases().then(d=>d.map(x=>x.name))`, true);

app.whenReady().then(async () => {
  const keeper = new BrowserWindow({ show: false }); // 保活，防止关窗即退出

  let win = new BrowserWindow({ width: 414, height: 736, x: 100, y: 60, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false } });
  win.setAlwaysOnTop(true);
  await win.loadURL('http://game.migoup.com/h5/wydgn');
  await sleep(12000);
  await enterMode(win);
  await sleep(6000);
  console.log('第一次进入后 IDB:', JSON.stringify(await idbNames(win)));

  // 导航到 about:blank 释放 IDB 连接，再清存储
  await win.loadURL('about:blank');
  await sleep(1500);
  const storages = ['indexdb', 'localstorage', 'sessionstorage', 'cookies', 'cachestorage', 'serviceworkers'];
  for (const origin of ['http://h5.migoup.com', 'http://game.migoup.com']) {
    await session.defaultSession.clearStorageData({ origin, storages });
  }
  console.log('已清理存储');

  // 重新加载
  await win.loadURL('http://game.migoup.com/h5/wydgn');
  await sleep(12000);
  console.log('重开主菜单后 IDB:', JSON.stringify(await idbNames(win)));
  await enterMode(win);
  await sleep(6000);
  const shot = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/verify/reopen.png', shot.toPNG());
  console.log('重开进入关卡，截图已存');

  app.quit();
});
