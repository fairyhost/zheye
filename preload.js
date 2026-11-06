const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  toggleMemo: () => ipcRenderer.send('pet:toggle-memo'),
  showMenu: () => ipcRenderer.send('pet:menu'),
  setPeek: (on) => ipcRenderer.send('pet:peek', !!on),
  onBubble: (cb) => ipcRenderer.on('pet:bubble', (_e, p) => cb(p)),
  onDockState: (cb) => ipcRenderer.on('pet:dock-state', (_e, s) => cb(s)),
});

contextBridge.exposeInMainWorld('memoAPI', {
  getState: () => ipcRenderer.invoke('memo:get-state'),
  addTask: (payload) => ipcRenderer.invoke('memo:add-task', payload),
  toggleDone: (id) => ipcRenderer.invoke('memo:toggle-done', { id }),
  updateTask: (payload) => ipcRenderer.invoke('memo:update-task', payload),
  deleteTask: (id) => ipcRenderer.invoke('memo:delete-task', { id }),
  hide: () => ipcRenderer.send('memo:hide'),
  getPinned: () => ipcRenderer.invoke('win:get-pinned', 'memo'),
  setPinned: (p) => ipcRenderer.invoke('win:set-pinned', { which: 'memo', pinned: !!p }),
  onState: (cb) => ipcRenderer.on('memo:state', (_e, s) => cb(s)),
});

contextBridge.exposeInMainWorld('askAPI', {
  answer: (yes) => ipcRenderer.send('ask:answer', !!yes),
});

contextBridge.exposeInMainWorld('ganttAPI', {
  toggle: () => ipcRenderer.send('gantt:toggle'),
  getPinned: () => ipcRenderer.invoke('win:get-pinned', 'gantt'),
  setPinned: (p) => ipcRenderer.invoke('win:set-pinned', { which: 'gantt', pinned: !!p }),
});
