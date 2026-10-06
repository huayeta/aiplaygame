const { ipcRenderer } = require('electron');

// 捕获真人操作（录制时使用），鼠标与触摸都抓
window.addEventListener('pointerdown', (e) => {
  if (e.isPrimary !== false) ipcRenderer.send('game:pointer', { x: e.clientX, y: e.clientY });
}, true);

window.addEventListener('touchstart', (e) => {
  const t = e.touches && e.touches[0];
  if (t) ipcRenderer.send('game:pointer', { x: t.clientX, y: t.clientY });
}, true);
