// 视觉识别：读出一局「萌宠排排排」棋盘（5列每块类型 + 顶部候选 + 底部槽位）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// CSS 窗口尺寸
const W = 414, H = 736;
let dbg;
async function click(win, x, y) {
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await sleep(100);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(60);
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

// 用颜色主色相分类萌宠：狐狸=橙红, 青蛙=绿, 柴犬=黄棕
function classify(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 60) return '?'; // 太暗
  let h = 0;
  if (max === min) h = 0;
  else if (max === r) h = 60 * ((g - b) / (max - min) % 6);
  else if (max === g) h = 60 * ((b - r) / (max - min) + 2);
  else h = 60 * ((r - g) / (max - min) + 4);
  if (h < 0) h += 360;
  // 判定
  if (h >= 15 && h < 55) return '柴犬黄';
  if (h >= 55 && h < 170) return '青蛙绿';
  if ((h >= 170 && h < 300) || h >= 340) return '狐狸橙/红';
  return '?';
}

// 取块内采样像素，统计最多出现的色相类别
function blockType(img, bx, by, bw, bh, W_, H_) {
  // img 是原生位图 (W_*H_*4)
  const counts = {};
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const px = Math.round(bx + bw * (0.2 + 0.6 * i / 8));
      const py = Math.round(by + bh * (0.2 + 0.6 * j / 8));
      if (px < 0 || py < 0 || px >= W_ || py >= H_) continue;
      const o = (py * W_ + px) * 4;
      const c = classify(img[o], img[o + 1], img[o + 2]);
      counts[c] = (counts[c] || 0) + 1;
    }
  }
  let best = '?', bn = 0;
  for (const k in counts) if (counts[k] > bn) { bn = counts[k]; best = k; }
  return { type: best, conf: bn / 64 };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, x: 60, y: 40, show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, devTools: false } });
  win.setAlwaysOnTop(true);
  await win.loadURL('http://game.migoup.com/h5/wydgn');
  await sleep(12000);
  dbg = win.webContents.debugger;
  await dbg.attach('1.3');
  await click(win, 207, 556); // 进萌宠排排排
  await sleep(8000);

  const shot = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/explore/board_raw.png', shot.toPNG());
  const img = shot.toBitmap();
  const W_ = shot.getSize().width, H_ = shot.getSize().height; // capturePage 尺寸可能2x
  console.log('capture size', W_, 'x', H_);
  const sx = W_ / W, sy = H_ / H; // 缩放

  // 列中心 CSS x（从列编号推算），块高CSS约44
  const colX = [138, 175, 211, 248, 284];
  const topY = 221, bottomY = 442, rows = 5;
  const rowH = (bottomY - topY) / rows;

  console.log('--- 5列砖块（自上而下） ---');
  for (let c = 0; c < 5; c++) {
    let seq = [];
    for (let r = 0; r < rows; r++) {
      const by = topY + r * rowH;
      const bx = colX[c] - 20;
      const t = blockType(img, bx * sx, by * sy, 40 * sx, rowH * sy, W_, H_);
      seq.push(t.type + ':' + t.conf.toFixed(2));
    }
    console.log('列' + (c + 1) + ' (' + colX[c] + '): ' + seq.join(' | '));
  }

  // 顶部候选区（y 150-210 CSS）
  console.log('--- 顶部候选（y150-210） ---');
  for (let c = 0; c < 5; c++) {
    const t = blockType(img, (colX[c] - 20) * sx, 150 * sy, 40 * sx, 60 * sy, W_, H_);
    console.log('候选列' + (c + 1) + ': ' + t.type + ':' + t.conf.toFixed(2));
  }

  // 底部槽位（y 596-660 CSS）
  console.log('--- 底部槽位（y596-660） ---');
  const slotX = [124, 161, 195, 232, 269];
  for (let c = 0; c < 3; c++) {
    const t = blockType(img, (slotX[c] * 2 - 20) * sx, 596 * sy, 40 * sx, 60 * sy, W_, H_);
    console.log('槽' + (c + 1) + ': ' + t.type + ':' + t.conf.toFixed(2));
  }

  app.quit();
});
