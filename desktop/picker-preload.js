// The screen picker's bridge: it can list the sources it was given and
// report the one the user chose. Nothing else.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id) => ipcRenderer.send('picker:choose', id),
  cancel: () => ipcRenderer.send('picker:choose', null),
});
