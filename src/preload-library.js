const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listGames: () => ipcRenderer.invoke('games:list'),
  addGame: (g) => ipcRenderer.invoke('games:add', g),
  updateGame: (id, patch) => ipcRenderer.invoke('games:update', id, patch),
  deleteGame: (id) => ipcRenderer.invoke('games:delete', id),
  startGame: (id) => ipcRenderer.invoke('game:start', id)
});
