const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  dragStart: () => ipcRenderer.send('widget:drag-start'),
  dragEnd: () => ipcRenderer.send('widget:drag-end'),
  toggleMemo: () => ipcRenderer.send('widget:toggle-memo'),
  showMenu: () => ipcRenderer.send('widget:menu'),
  setPeek: (on) => ipcRenderer.send('widget:peek', !!on),
  onBubble: (cb) => ipcRenderer.on('widget:bubble', (_e, p) => cb(p)),
  onDockState: (cb) => ipcRenderer.on('widget:dock-state', (_e, s) => cb(s)),
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
