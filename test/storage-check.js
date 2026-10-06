// 诊断：关卡进度存在哪；清理后能否回到第1关
const { app, BrowserWindow } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dumpStorage(win, label) {
  const js = `(async () => {
    const out = {};
    try { out.localStorage = Object.keys(localStorage).map(k => k + '=' + localStorage.getItem(k)); } catch(e){}
    try { out.sessionStorage = Object.keys(sessionStorage).map(k => k + '=' + sessionStorage.getItem(k)); } catch(e){}
    try { out.cookie = document.cookie; } catch(e){}
    return out;
  })()`;
  const r = await win.webContents.executeJavaScript(js, true);
  console.log('--- ' + label + ' ---');
  console.log(JSON.stringify(r, null, 2));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 414, height: 736, x: 100, y: 60, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false }
  });
  win.setAlwaysOnTop(true);
  await win.loadURL('http://game.migoup.com/h5/wydgn');
  await sleep(12000);
  await dumpStorage(win, '主菜单（默认）');

  // 进入一个模式
  const dbg = win.webContents.debugger;
  await dbg.attach('1.3');
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 207, y: 552, button: 'none', buttons: 0 });
  await sleep(100);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 207, y: 552, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 207, y: 552, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(6000);
  await dumpStorage(win, '进入关卡后');

  app.quit();
});
