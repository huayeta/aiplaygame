// 诊断2：IndexedDB + game.migoup 来源 + 网络请求
const { app, BrowserWindow, session } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 414, height: 736, x: 100, y: 60, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false }
  });
  win.setAlwaysOnTop(true);

  // 记录网络请求
  const apiCalls = [];
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    if (!d.url.includes('.js') && !d.url.includes('.png') && !d.url.includes('.json') && !d.url.includes('51.la') && !d.url.includes('sensors'))
      apiCalls.push(d.url);
    cb({});
  });

  await win.loadURL('http://game.migoup.com/h5/wydgn');
  await sleep(12000);

  // IndexedDB 列表（h5 来源）
  const idb = await win.webContents.executeJavaScript(`indexedDB.databases ? indexedDB.databases() : 'no api'`, true);
  console.log('h5 IndexedDB:', JSON.stringify(idb));

  // 进入模式
  const dbg = win.webContents.debugger;
  await dbg.attach('1.3');
  for (const [type, x, y, button, buttons] of [
    ['mouseMoved', 207, 552, 'none', 0],
    ['mousePressed', 207, 552, 'left', 1],
    ['mouseReleased', 207, 552, 'left', 0]
  ]) {
    await sleep(100);
    await dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
  }
  await sleep(6000);
  const idb2 = await win.webContents.executeJavaScript(`indexedDB.databases ? indexedDB.databases() : 'no api'`, true);
  console.log('进关卡后 IndexedDB:', JSON.stringify(idb2));

  // 全量 localStorage（含所有键，看是否有 unity 相关）
  const ls = await win.webContents.executeJavaScript(`JSON.stringify(Object.keys(localStorage))`, true);
  console.log('h5 localStorage keys:', ls);

  console.log('非静态 API 请求:');
  apiCalls.slice(0, 30).forEach(u => console.log('  ' + u));

  app.quit();
});
