// The bridge between the sandboxed client page and the desktop shell. The
// page sees only `window.pravdaDesktop` and the functions below; it gets no
// Node.js, no Electron and no access to files.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('desktop:info') ?? {};

contextBridge.exposeInMainWorld('pravdaDesktop', {
  platform: info.platform,
  version: info.version,
  globalShortcuts: !!info.globalShortcuts,
  shortcuts: info.shortcuts ?? {},

  getToken: (origin) => ipcRenderer.invoke('token:get', origin),
  setToken: (origin, token) => ipcRenderer.invoke('token:set', origin, token),

  listInstances: () => ipcRenderer.invoke('instances:list'),
  currentInstance: () => ipcRenderer.invoke('instances:current'),
  addInstance: (entry) => ipcRenderer.invoke('instances:add', { url: entry?.url, name: entry?.name }),
  selectInstance: (origin) => ipcRenderer.invoke('instances:select', origin),
  switchInstance: () => ipcRenderer.invoke('instances:switch'),
  checkServer: (url) => ipcRenderer.invoke('server:check', url),

  startHosting: () => ipcRenderer.invoke('host:start'),
  hostStatus: () => ipcRenderer.invoke('host:status'),

  onShortcut: (fn) => {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('desktop:shortcut', (_event, name) => fn(String(name)));
  },

  getPreferences: () => ipcRenderer.invoke('prefs:get'),
  setPreference: (key, value) => ipcRenderer.invoke('prefs:set', key, value),

  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: (fn) => {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('desktop:update-state', (_event, state) => fn(state));
  },
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  deferUpdate: () => ipcRenderer.invoke('update:defer'),
  skipUpdate: (version) => ipcRenderer.invoke('update:skip', version),

  setBadge: (count) => ipcRenderer.send('desktop:badge', count),
  flash: () => ipcRenderer.send('desktop:flash'),
  focusWindow: () => ipcRenderer.send('desktop:focus'),
});
