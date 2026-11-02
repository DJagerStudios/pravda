// Pravda's desktop shell.
//
// It runs the same web client the server ships, loaded from the app's own
// app://pravda origin, and adds what a browser tab cannot offer:
//
//   * sign-in tokens kept in the operating system's keychain (safeStorage);
//   * global shortcuts for mute and deafen, and a tray icon;
//   * a screen and window picker for screen sharing;
//   * trust for a LAN server's self-signed certificate, pinned by fingerprint
//     after the user confirms it, never silently;
//   * the option to host a Pravda server on this computer;
//   * self-updating from signed GitHub releases (update.js);
//   * a remembered window size, opening at login, and unread badges.
//
// The renderer is sandboxed and isolated; it reaches the main process only
// through the small API in preload.js, and every IPC call checks that it
// came from the app's own pages.

'use strict';

const {
  app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain,
  nativeImage, net, protocol, safeStorage, screen, session, shell,
} = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Updater } = require('./update.js');

const SCHEME = 'app';
const APP_HOST = 'pravda';
const APP_ORIGIN = `${SCHEME}://${APP_HOST}`;
const DEV = process.argv.includes('--dev') || process.env.PRAVDA_DEV === '1';

// The client and the artwork: bundled next to this file in a packaged build,
// or straight from the repository while developing.
const WEB_DIR = [path.join(__dirname, 'web'), path.join(__dirname, '..', 'web', 'public')]
  .find((dir) => fs.existsSync(path.join(dir, 'index.html')));
const UI_DIR = path.join(__dirname, 'ui');
const ICON = [path.join(__dirname, 'icon.png'), path.join(__dirname, '..', 'packaging', 'icons', 'icon-512.png')]
  .find((file) => fs.existsSync(file));

const SHORTCUTS = { mute: 'CommandOrControl+Shift+M', deafen: 'CommandOrControl+Shift+D' };
// Hosting uses the server's usual ports; tests move them out of the way.
const HOST_PORT = Number(process.env.PRAVDA_HOST_PORT) || 8347;
const MEDIA_PORT = Number(process.env.PRAVDA_MEDIA_PORT) || 8348;

let mainWindow = null;
let tray = null;
let quitting = false;
let globalShortcutsActive = false;
let hosted = null; // { child, port, fingerprint, log }
let updater = null;
let badgeCount = 0;
const TRAY_ICONS = path.join(__dirname, 'icons');

// ---- storage ---------------------------------------------------------------

const store = {
  path: (name) => path.join(app.getPath('userData'), name),
  read(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.path(name), 'utf8'));
    } catch {
      return fallback;
    }
  },
  write(name, value) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    const tmp = `${this.path(name)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.path(name));
  },
};

/** Normalises a server address to its origin, refusing anything unsafe. */
function serverOrigin(input) {
  const url = new URL(String(input));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Pravda servers must use HTTPS (plain HTTP is allowed only on this computer).');
  }
  return url.origin;
}

// ---- preferences ---------------------------------------------------------

const PREF_DEFAULTS = {
  openAtLogin: false,
  startMinimized: false,
  closeToTray: true,
  autoUpdate: true,
  betaUpdates: false,
  skipVersion: null,
  window: null, // { x, y, width, height, maximized }
};

function prefs() {
  return { ...PREF_DEFAULTS, ...store.read('prefs.json', {}) };
}

function setPref(key, value) {
  if (!(key in PREF_DEFAULTS)) throw new Error('Unknown preference.');
  const next = { ...prefs(), [key]: value };
  store.write('prefs.json', next);
  if (key === 'openAtLogin') applyOpenAtLogin(!!value);
  if (key === 'autoUpdate' && value) updater?.run({}).catch(() => {});
  return next;
}

/** Opens Pravda at login: the system's login items, or an autostart entry on Linux. */
function applyOpenAtLogin(on) {
  if (process.platform === 'linux') {
    const dir = path.join(app.getPath('appData'), 'autostart');
    const file = path.join(dir, 'pravda.desktop');
    if (!on) {
      fs.rmSync(file, { force: true });
      return;
    }
    const exec = process.env.APPIMAGE || process.execPath;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Pravda',
      'Comment=End-to-end encrypted chat, voice and video',
      `Exec="${exec.replace(/"/g, '\\"')}" --hidden`,
      'Icon=pravda',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
}

function openedAtLogin() {
  if (process.argv.includes('--hidden')) return true;
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
}

function instances() {
  const data = store.read('instances.json', { current: null, list: [] });
  if (!Array.isArray(data.list)) data.list = [];
  return data;
}

// Tokens are encrypted by the operating system's keychain: Keychain on
// macOS, DPAPI on Windows, KWallet or the Secret Service on Linux. A Linux
// desktop without a keyring gets Electron's fallback, which only obscures the
// file; that matches what a browser does with its cookies, and SECURITY.md
// says so.
function storageReady() {
  if (safeStorage.isEncryptionAvailable()) return true;
  if (process.platform === 'linux' && typeof safeStorage.setUsePlainTextEncryption === 'function') {
    safeStorage.setUsePlainTextEncryption(true);
    return true;
  }
  return false;
}

function readToken(origin) {
  const entry = store.read('tokens.json', {})[origin];
  if (!entry?.enc || !storageReady()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
  } catch {
    return null;
  }
}

function writeToken(origin, token) {
  const all = store.read('tokens.json', {});
  delete all[origin];
  if (token && storageReady()) {
    try {
      all[origin] = {
        enc: safeStorage.encryptString(token).toString('base64'),
        backend: safeStorage.getSelectedStorageBackend?.() ?? process.platform,
      };
    } catch (err) {
      console.warn('the session could not be stored; you will sign in again next time', err);
    }
  }
  store.write('tokens.json', all);
}

// ---- certificate pins ------------------------------------------------------

const normalFingerprint = (value) => String(value).replace(/[^0-9a-f]/gi, '').toLowerCase();
// Groups of four, easy to read aloud and to wrap: the trust prompt and the
// hosting page show the same text.
const showFingerprint = (hex) => hex.toUpperCase().match(/.{1,4}/g).join(' ');

function fingerprintOfPem(pem) {
  try {
    return normalFingerprint(new crypto.X509Certificate(pem).fingerprint256);
  } catch {
    return null;
  }
}

function pins() {
  return store.read('certificate-pins.json', {});
}

function pin(hostname, fingerprint) {
  const all = pins();
  all[hostname] = normalFingerprint(fingerprint);
  store.write('certificate-pins.json', all);
}

// Chromium verifies certificates as usual. Only when that fails does a pin
// matter: a certificate whose fingerprint the user accepted for this host is
// trusted, and nothing else.
function installCertificateCheck() {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.errorCode === 0) return callback(-3);
    const expected = pins()[request.hostname];
    if (expected && fingerprintOfPem(request.certificate.data) === expected) return callback(0);
    return callback(-3);
  });
}

/**
 * Asks a server for its description before the user adds it. A server with a
 * self-signed certificate is offered for trust by fingerprint, once.
 */
function probeServer(origin) {
  const url = new URL('/api/v1/instance', origin);
  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { rejectUnauthorized: false, timeout: 8000 }, (res) => {
      const socket = res.socket;
      const cert = url.protocol === 'https:' ? socket.getPeerCertificate() : null;
      const authorized = url.protocol === 'http:' || socket.authorized;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let info = null;
        try {
          info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch { /* not a Pravda server */ }
        resolve({
          ok: res.statusCode === 200 && info && typeof info.name === 'string',
          info,
          authorized,
          fingerprint: cert?.fingerprint256 ? normalFingerprint(cert.fingerprint256) : null,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, unreachable: true }));
  });
}

async function checkServer(input) {
  const origin = serverOrigin(input);
  const hostname = new URL(origin).hostname;
  const result = await probeServer(origin);
  if (result.unreachable) return { ok: false, error: 'Could not reach a Pravda server at that address.' };
  if (!result.ok) return { ok: false, error: 'That address did not answer like a Pravda server.' };
  if (!result.authorized) {
    const known = pins()[hostname];
    if (known !== result.fingerprint) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Trust this server?',
        message: `${hostname} uses its own certificate`,
        detail: 'This is normal for a server on a home or office network. Ask the person running it to read '
          + 'out their fingerprint and check that it matches:\n\n'
          + `${showFingerprint(result.fingerprint)}\n\n`
          + (known ? 'Warning: this server showed a different certificate before.\n\n' : '')
          + 'Only trust it if the fingerprints match.',
        buttons: ['Cancel', 'Trust this server'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return { ok: false, error: 'The server was not trusted.' };
      pin(hostname, result.fingerprint);
    }
  }
  return { ok: true, origin, name: result.info.name };
}

// ---- hosting a server ------------------------------------------------------

function serverBinary() {
  const name = process.platform === 'win32' ? 'pravda.exe' : 'pravda';
  return [process.env.PRAVDA_SERVER, path.join(process.resourcesPath ?? '', 'server', name), path.join(__dirname, 'server', name)]
    .filter(Boolean)
    .find((file) => fs.existsSync(file));
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (!a.internal && a.family === 'IPv4') out.push(a.address);
    }
  }
  return out;
}

function hostStatus() {
  if (!hosted) return { available: !!serverBinary(), running: false };
  return {
    available: true,
    running: hosted.running,
    url: `https://localhost:${hosted.port}`,
    lanUrls: lanAddresses().map((ip) => `https://${ip}:${hosted.port}`),
    fingerprint: hosted.fingerprint ? showFingerprint(hosted.fingerprint) : null,
    ports: { web: hosted.port, media: MEDIA_PORT },
  };
}

function waitForHealth(port, child) {
  const deadline = Date.now() + 20000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) return reject(new Error('The server stopped while starting. See server.log.'));
      const req = https.get({ host: '127.0.0.1', port, path: '/healthz', rejectUnauthorized: false, timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => req.destroy());
    };
    const retry = () => (Date.now() > deadline ? reject(new Error('The server did not start in time.')) : setTimeout(attempt, 250));
    attempt();
  });
}

async function startHosting() {
  if (hosted?.running) return hostStatus();
  const binary = serverBinary();
  if (!binary) throw new Error('This build of Pravda does not include the server.');
  const dataDir = path.join(app.getPath('userData'), 'server');
  fs.mkdirSync(dataDir, { recursive: true });
  const log = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' });
  const child = spawn(binary, [
    '--listen', `0.0.0.0:${HOST_PORT}`,
    '--data', dataDir,
    '--tls-self-signed',
    '--name', `${os.hostname()}'s Pravda`,
    '--media-udp', String(MEDIA_PORT),
    '--media-tcp', String(MEDIA_PORT),
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  hosted = { child, port: HOST_PORT, running: true, fingerprint: null };
  child.on('exit', () => {
    if (hosted?.child === child) hosted.running = false;
  });
  await waitForHealth(HOST_PORT, child);
  // The server wrote its certificate on start; trust it for the names this
  // computer answers to.
  const fingerprint = fingerprintOfPem(fs.readFileSync(path.join(dataDir, 'selfsigned.crt'), 'utf8'));
  hosted.fingerprint = fingerprint;
  for (const name of ['localhost', '127.0.0.1', ...lanAddresses()]) pin(name, fingerprint);
  return hostStatus();
}

function stopHosting() {
  if (!hosted?.running) return;
  hosted.child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
}

// ---- the app:// protocol ---------------------------------------------------

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

// The same rules as the server's own pages, except that the client talks to
// whichever server the user picked.
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: https:; "
  + "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; "
  + "frame-src https://www.youtube-nocookie.com; worker-src 'self' blob:; style-src 'self'; font-src 'self'; "
  + "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function serveApp(request) {
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return new Response('Not found', { status: 404 });
  const pathname = decodeURIComponent(url.pathname);
  // The desktop's own pages (the screen picker) live under /desktop/.
  const [root, rel] = pathname.startsWith('/desktop/') ? [UI_DIR, pathname.slice('/desktop'.length)] : [WEB_DIR, pathname];
  let file = path.normalize(path.join(root, rel));
  if (file !== root && !file.startsWith(root + path.sep)) return new Response('Not found', { status: 404 });
  if (!path.extname(file)) file = path.join(WEB_DIR, 'index.html'); // client-side routes
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 });
  const res = await net.fetch(pathToFileURL(file).toString());
  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache',
    },
  });
}

// ---- IPC -------------------------------------------------------------------

function fromApp(event) {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith(`${APP_ORIGIN}/`);
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromApp(event)) throw new Error('refused');
    return fn(...args);
  });
}

function installIpc() {
  ipcMain.on('desktop:info', (event) => {
    event.returnValue = fromApp(event)
      ? { platform: process.platform, version: app.getVersion(), globalShortcuts: globalShortcutsActive, shortcuts: SHORTCUTS }
      : null;
  });
  handle('token:get', (origin) => readToken(serverOrigin(origin)));
  handle('token:set', (origin, token) => writeToken(serverOrigin(origin), typeof token === 'string' ? token : null));
  handle('instances:list', () => instances().list);
  handle('instances:current', () => instances().current);
  handle('instances:add', ({ url, name }) => {
    const origin = serverOrigin(url);
    const data = instances();
    const entry = { url: origin, name: String(name || origin).slice(0, 80) };
    data.list = [entry, ...data.list.filter((i) => i.url !== origin)].slice(0, 20);
    store.write('instances.json', data);
    return data.list;
  });
  handle('instances:select', (origin) => {
    const data = instances();
    const chosen = serverOrigin(origin);
    if (!data.list.some((i) => i.url === chosen)) throw new Error('Unknown server.');
    data.current = chosen;
    store.write('instances.json', data);
  });
  handle('instances:switch', () => switchServer());
  handle('server:check', (url) => checkServer(url));
  handle('host:start', () => startHosting());
  handle('host:status', () => hostStatus());
  handle('prefs:get', () => {
    const { window: _window, ...rest } = prefs();
    return rest;
  });
  handle('prefs:set', (key, value) => {
    if (key === 'window') throw new Error('refused');
    const { window: _window, ...rest } = setPref(String(key), value);
    return rest;
  });
  handle('update:state', () => updater?.state ?? { phase: 'unsupported' });
  handle('update:check', () => updater?.run({ manual: true }));
  handle('update:download', () => updater?.downloadAndInstall());
  handle('update:install', () => updater?.install().catch((err) => updater.set({ phase: 'error', error: err.message })));
  handle('update:defer', () => updater?.defer());
  handle('update:skip', (version) => updater?.skip(String(version)));
  ipcMain.on('desktop:badge', (event, count) => {
    if (fromApp(event)) setBadge(Math.max(0, Math.floor(Number(count) || 0)));
  });
  ipcMain.on('desktop:flash', (event) => {
    if (fromApp(event) && mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  });
  ipcMain.on('desktop:focus', (event) => {
    if (fromApp(event)) showWindow();
  });
}

// ---- unread badge ----------------------------------------------------------

/** Shows the unread mention count on the dock, taskbar and tray. */
function setBadge(count) {
  if (count === badgeCount) return;
  badgeCount = count;
  app.setBadgeCount?.(count);
  if (tray) {
    tray.setImage(trayImage(count > 0));
    tray.setToolTip(count > 0 ? `Pravda — ${count} unread ${count === 1 ? 'mention' : 'mentions'}` : 'Pravda');
  }
  if (process.platform === 'win32' && mainWindow) {
    mainWindow.setOverlayIcon(count > 0 ? nativeImage.createFromPath(path.join(TRAY_ICONS, 'overlay.png')) : null,
      count > 0 ? `${count} unread mentions` : '');
  }
}

function trayImage(badge) {
  return nativeImage.createFromPath(path.join(TRAY_ICONS, badge ? 'tray-badge.png' : 'tray.png'));
}

// ---- screen picker ---------------------------------------------------------

let pickerState = null;

function pickSource(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: mainWindow ?? undefined,
      modal: !!mainWindow,
      width: 760,
      height: 560,
      minWidth: 520,
      minHeight: 420,
      title: 'Share your screen',
      backgroundColor: '#efe6d2',
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, sandbox: true },
    });
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      pickerState = null;
      resolve(sources.find((s) => s.id === id) ?? null);
      if (!picker.isDestroyed()) picker.close();
    };
    pickerState = {
      webContentsId: picker.webContents.id,
      list: sources.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      })),
      finish,
    };
    picker.on('closed', () => finish(null));
    picker.loadURL(`${APP_ORIGIN}/desktop/picker.html`);
  });
}

ipcMain.handle('picker:sources', (event) => (pickerState && event.sender.id === pickerState.webContentsId ? pickerState.list : []));
ipcMain.on('picker:choose', (event, id) => {
  if (pickerState && event.sender.id === pickerState.webContentsId) pickerState.finish(typeof id === 'string' ? id : null);
});

function installDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });
      // On Wayland the system's own portal dialog has already asked, and
      // only the chosen source comes back.
      const chosen = sources.length === 1 ? sources[0] : sources.length > 1 ? await pickSource(sources) : null;
      if (!chosen) return callback({});
      const audio = process.platform === 'win32' && request.audioRequested ? 'loopback' : undefined;
      return callback(audio ? { video: chosen, audio } : { video: chosen });
    } catch (err) {
      console.error('screen sharing', err);
      return callback({});
    }
  }, { useSystemPicker: true });
}

// ---- permissions -----------------------------------------------------------

const ALLOWED = new Set(['media', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'display-capture', 'speaker-selection']);

function installPermissions() {
  const ours = (url) => typeof url === 'string' && url.startsWith(`${APP_ORIGIN}/`);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(ours(details.requestingUrl) && ALLOWED.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return ours(`${requestingOrigin}/`) && ALLOWED.has(permission);
  });
  // YouTube's privacy-enhanced player refuses to play without knowing which
  // site embeds it, and an app:// page sends no referrer. Name the Pravda
  // server the user is connected to.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube-nocookie.com/*'] },
    (details, callback) => {
      const current = instances().current;
      if (current && !details.requestHeaders.Referer) details.requestHeaders.Referer = `${current}/`;
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

// ---- window, tray, menu, shortcuts ------------------------------------------

function sendShortcut(name) {
  mainWindow?.webContents.send('desktop:shortcut', name);
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function switchServer() {
  const data = instances();
  data.current = null;
  store.write('instances.json', data);
  mainWindow?.loadURL(`${APP_ORIGIN}/`);
}

/** The last window size and place, if it still fits a screen. */
function savedBounds() {
  const saved = prefs().window;
  if (!saved?.width || !saved?.height) return { width: 1280, height: 820 };
  const size = { width: Math.max(940, saved.width), height: Math.max(560, saved.height) };
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return size;
  const area = screen.getDisplayMatching({ ...size, x: saved.x, y: saved.y }).workArea;
  const visible = saved.x < area.x + area.width - 100 && saved.x + size.width > area.x + 100
    && saved.y >= area.y - 20 && saved.y < area.y + area.height - 100;
  return visible ? { ...size, x: saved.x, y: saved.y } : size;
}

let saveTimer = null;
function rememberBounds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const bounds = mainWindow.getNormalBounds();
    const next = { ...prefs(), window: { ...bounds, maximized: mainWindow.isMaximized() } };
    store.write('prefs.json', next);
  }, 400);
}

function createWindow({ hidden = false } = {}) {
  const bounds = savedBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 940,
    minHeight: 560,
    title: 'Pravda',
    icon: ICON,
    backgroundColor: '#efe6d2',
    autoHideMenuBar: true,
    // Shown at once: the background matches the opening animation, so there
    // is no flash, and on Wayland a hidden window never paints its first
    // frame, so waiting for 'ready-to-show' could wait forever. Opening at
    // login into the tray is the one exception.
    show: !hidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false, // calls keep running while the window is hidden
    },
  });
  if (prefs().window?.maximized) mainWindow.maximize();
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) mainWindow.on(event, rememberBounds);
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  mainWindow.on('close', (event) => {
    rememberBounds();
    // Like other chat apps, closing the window keeps Pravda running in the
    // tray so calls and notifications continue. Quit from the tray or menu.
    if (!quitting && tray && prefs().closeToTray && process.platform !== 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  const wc = mainWindow.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.loadURL(`${APP_ORIGIN}/`);
}

function createTray() {
  try {
    tray = new Tray(trayImage(false));
  } catch (err) {
    console.warn('no tray', err);
    tray = null;
    return;
  }
  tray.setToolTip('Pravda');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Pravda', click: showWindow },
    { type: 'separator' },
    { label: 'Mute or unmute', click: () => sendShortcut('mute') },
    { label: 'Deafen or undeafen', click: () => sendShortcut('deafen') },
    { type: 'separator' },
    { label: 'Quit Pravda', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function createMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: isMac ? app.name : 'Pravda',
      submenu: [
        ...(isMac ? [{ role: 'about' }, { type: 'separator' }] : []),
        { label: 'Switch server…', click: switchServer },
        { label: 'Check for updates…', click: () => { showWindow(); updater?.run({ manual: true }); } },
        { type: 'separator' },
        ...(isMac ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }] : []),
        { label: 'Quit Pravda', accelerator: 'CommandOrControl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(DEV ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    { role: 'windowMenu' },
  ]));
}

function registerShortcuts() {
  let ok = true;
  for (const [name, accelerator] of Object.entries(SHORTCUTS)) {
    try {
      ok = globalShortcut.register(accelerator, () => sendShortcut(name)) && ok;
    } catch {
      ok = false;
    }
  }
  globalShortcutsActive = ok;
}

// ---- start -----------------------------------------------------------------

// A separate profile, for tests or a portable copy.
if (process.env.PRAVDA_USER_DATA) app.setPath('userData', path.resolve(process.env.PRAVDA_USER_DATA));

/** Takes the single-instance lock, waiting a little after an update restart. */
function acquireLockThen(start, attempts) {
  if (app.requestSingleInstanceLock()) {
    start();
    return;
  }
  // Restarting after an update, the old copy may still be letting go.
  if (attempts > 0) {
    setTimeout(() => acquireLockThen(start, attempts - 1), 250);
    return;
  }
  app.quit();
}

acquireLockThen(() => {
  app.setName('Pravda');
  if (process.platform === 'win32') app.setAppUserModelId('org.pravda.desktop');
  if (process.platform === 'linux') app.setDesktopName('pravda.desktop');

  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    stopHosting();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // A shutdown signal quits cleanly too, taking a hosted server with it.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      quitting = true;
      stopHosting();
      app.quit();
    });
  }
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', showWindow);
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(() => {
    if (!WEB_DIR) {
      dialog.showErrorBox('Pravda', 'The Pravda client files are missing from this build.');
      app.quit();
      return;
    }
    protocol.handle(SCHEME, serveApp);
    installCertificateCheck();
    installPermissions();
    installDisplayMedia();
    installIpc();
    registerShortcuts();
    createMenu();
    createTray();
    // Opened at login with "Start in the tray": wait there until wanted.
    createWindow({ hidden: !!tray && openedAtLogin() && prefs().startMinimized });
    updater = new Updater({
      userData: app.getPath('userData'),
      getPrefs: prefs,
      setPref,
      onState: (state) => mainWindow?.webContents.send('desktop:update-state', state),
      beforeRestart: () => {
        quitting = true;
        stopHosting();
      },
    });
    updater.start();
  });
}, process.argv.includes('--after-update') ? 40 : 0);
