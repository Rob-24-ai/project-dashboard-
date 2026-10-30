const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the titlebar strip in shell.html.
contextBridge.exposeInMainWorld('tower', {
  togglePin: () => ipcRenderer.invoke('toggle-pin'),
  getPin: () => ipcRenderer.invoke('get-pin'),
  close: () => ipcRenderer.invoke('close-window')
});
