const { contextBridge, ipcRenderer } = require('electron');

// The content view can request only a bounded window size. It gets no titlebar IPC.
contextBridge.exposeInMainWorld('towerLayout', {
  report: metrics => ipcRenderer.send('tower-layout', metrics),
  pointerInside: () => ipcRenderer.invoke('pointer-inside')
});
