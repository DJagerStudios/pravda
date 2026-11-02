// Pravda's self-updater.
//
// When Pravda starts, and every few hours after, it asks GitHub for the
// newest release. Each release carries a manifest, Pravda-<version>-update.json,
// listing every download with its size and SHA-256, and a detached Ed25519
// signature over that manifest. The updater:
//
//   1. accepts only a manifest signed by the key built into the app
//      (release-key.pem), for a version newer than the running one;
//   2. downloads the file for this platform and checks its SHA-256 against
//      the signed manifest before touching anything;
//   3. installs it: an AppImage replaces itself, a folder install (Linux
//      tar.gz, Windows zip, macOS app) is swapped in by a small helper once
//      Pravda has quit, and the new version starts.
//
// Copies it cannot update (system packages, read-only folders) are offered a
// link to the release page instead. Nothing about the person is sent.

'use strict';

const { app, net } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('./package.json');

const REPOSITORY = pkg.pravda?.repository ?? 'DJagerStudios/pravda';
const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LAUNCH_WAIT_MS = 6000;
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;

// ---- versions ----------------------------------------------------------------

function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    text: `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ''}`,
  };
}

/** Semantic-version order: 0.3.0-beta.2 < 0.3.0 < 0.3.1. */
function compareVersions(a, b) {
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return a[k] - b[k];
  }
  if (!a.pre.length || !b.pre.length) return (a.pre.length ? -1 : 0) + (b.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---- where and how this copy is installed ---------------------------------------

function canWrite(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Which download fits this copy, and how to put it in place. */
function installation() {
  const x64 = process.arch !== 'arm64';
  if (process.platform === 'linux') {
    const arch = x64 ? 'x86_64' : 'aarch64';
    if (process.env.APPIMAGE) {
      const target = process.env.APPIMAGE;
      return { key: `linux-${arch}-appimage`, method: 'appimage', target, writable: canWrite(target) && canWrite(path.dirname(target)) };
    }
    const dir = path.dirname(process.execPath);
    if (/^\/(opt|usr)\//.test(dir)) return { key: `linux-${arch}-deb`, method: 'manual', writable: false };
    return { key: `linux-${arch}-tar`, method: 'folder', target: dir, writable: canWrite(dir) && canWrite(path.dirname(dir)) };
  }
  if (process.platform === 'win32') {
    const dir = path.dirname(process.execPath);
    return { key: `windows-${x64 ? 'x64' : 'arm64'}-zip`, method: 'folder', target: dir, writable: canWrite(dir) && canWrite(path.dirname(dir)) };
  }
  if (process.platform === 'darwin') {
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    return { key: `macos-${x64 ? 'x64' : 'arm64'}-zip`, method: 'bundle', target: bundle, writable: bundle.endsWith('.app') && canWrite(path.dirname(bundle)) };
  }
  return { key: null, method: 'manual', writable: false };
}

// ---- network ----------------------------------------------------------------

async function fetchOk(url, accept) {
  const res = await net.fetch(url, { headers: { Accept: accept ?? '*/*', 'User-Agent': `Pravda/${app.getVersion()}` } });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests right now; Pravda will try again later.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
  return res;
}

const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// Electron's sockets and files are not closed on exec, and Node does not
// close them for a child either. A new copy started straight from here would
// inherit them all (holding the old AppImage's mount busy, for one). This
// shell closes everything but stdio and waits for this process to exit
// before starting the program.
const TRAMPOLINE = `for f in /proc/$$/fd/*; do n=\${f##*/}; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-" 2>/dev/null; done
i=0; while kill -0 "$PRAVDA_OLD_PID" 2>/dev/null && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done
exec "$0" "$@"`;

function startDetached(program, args, env) {
  const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  spawn(shell, ['-c', TRAMPOLINE, program, ...args], {
    detached: true, stdio: 'ignore', env: { ...env, PRAVDA_OLD_PID: String(process.pid) },
  }).unref();
}
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

class Updater {
  /**
   * getPrefs() returns the desktop preferences; setPref(key, value) saves one.
   * onState(state) receives every change. beforeRestart() runs just before
   * Pravda quits to install.
   */
  constructor({ getPrefs, setPref, onState, beforeRestart, userData }) {
    this.getPrefs = getPrefs;
    this.setPref = setPref;
    this.onState = onState;
    this.beforeRestart = beforeRestart;
    this.dir = path.join(userData, 'updates');
    this.pendingFile = path.join(userData, 'update-pending.json');
    this.failedFile = path.join(userData, 'update-failed.json');
    this.publicKey = crypto.createPublicKey(fs.readFileSync(path.join(__dirname, 'release-key.pem')));
    this.supported = app.isPackaged && process.env.PRAVDA_NO_UPDATES !== '1';
    this.busy = false;
    this.found = null; // { version, prerelease, releaseUrl, file: { name, size, sha256, url } }
    this.downloaded = null; // path of a verified download
    this.state = { phase: this.supported ? 'idle' : 'unsupported', current: app.getVersion() };
    this.afterRestart();
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  // A restart to install leaves a note; the next start reads how it went.
  afterRestart() {
    let pending = null;
    try {
      pending = JSON.parse(fs.readFileSync(this.pendingFile, 'utf8'));
      fs.rmSync(this.pendingFile, { force: true });
    } catch {
      return;
    }
    if (pending.version === app.getVersion()) {
      // Kept apart from the phase, which the next check moves on at once.
      this.state = { ...this.state, updatedTo: pending.version };
      fs.rmSync(this.dir, { recursive: true, force: true });
    } else {
      const failed = this.readFailed();
      failed[pending.version] = Date.now();
      fs.writeFileSync(this.failedFile, JSON.stringify(failed));
      this.state = {
        ...this.state, phase: 'error', installFailed: true, version: pending.version,
        error: 'Pravda started again on the old version. It will try again later.',
      };
    }
  }

  readFailed() {
    try {
      return JSON.parse(fs.readFileSync(this.failedFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /** Starts the launch check and the periodic checks. */
  start() {
    if (!this.supported) return;
    this.run({ atLaunch: true }).catch(() => {});
    this.timer = setInterval(() => this.run({}).catch(() => {}), CHECK_EVERY_MS);
  }

  /** The newest release this copy may move to, or null. */
  async findUpdate(beta) {
    const current = parseVersion(app.getVersion());
    // Tests point PRAVDA_UPDATE_FEED at a local list shaped like GitHub's.
    const feed = process.env.PRAVDA_UPDATE_FEED || `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`;
    const releases = await (await fetchOk(feed, 'application/vnd.github+json')).json();
    const candidates = releases
      .filter((r) => !r.draft && (beta || !r.prerelease))
      .map((r) => ({ r, v: parseVersion(r.tag_name) }))
      .filter((x) => x.v && compareVersions(x.v, current) > 0)
      .sort((a, b) => compareVersions(b.v, a.v));
    for (const { r, v } of candidates) {
      const asset = (name) => r.assets?.find((a) => a.name === name)?.browser_download_url;
      const manifestUrl = asset(`Pravda-${v.text}-update.json`);
      const signatureUrl = asset(`Pravda-${v.text}-update.json.sig`);
      if (!manifestUrl || !signatureUrl) continue;
      const [manifestBytes, signature] = await Promise.all([
        fetchOk(manifestUrl).then((res) => res.arrayBuffer()).then((b) => Buffer.from(b)),
        fetchOk(signatureUrl).then((res) => res.text()),
      ]);
      if (!crypto.verify(null, manifestBytes, this.publicKey, Buffer.from(signature.trim(), 'base64'))) {
        throw new Error(`The signature on Pravda ${v.text} does not match Pravda's signing key, so it was ignored.`);
      }
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      if (manifest.version !== v.text) throw new Error(`The manifest for ${v.text} names another version.`);
      return { version: v.text, prerelease: !!r.prerelease, releaseUrl: r.html_url ?? `${RELEASES_PAGE}/tag/v${v.text}`, manifest, assets: r.assets ?? [] };
    }
    return null;
  }

  /**
   * One check. At launch the opening animation waits for it (briefly for
   * the check, and through the download), then the update installs at once.
   */
  async run({ atLaunch = false, manual = false } = {}) {
    if (!this.supported) {
      this.set({ phase: 'unsupported' });
      return;
    }
    if (this.busy || this.state.phase === 'ready') {
      if (manual && this.state.phase === 'ready') this.set({});
      return;
    }
    this.busy = true;
    const prefs = this.getPrefs();
    const holdSplash = atLaunch && prefs.autoUpdate;
    const release = holdSplash ? setTimeout(() => this.set({ atLaunch: false }), LAUNCH_WAIT_MS) : null;
    try {
      this.set({ phase: 'checking', atLaunch: holdSplash, deferred: false, error: null, installFailed: false });
      const found = await this.findUpdate(prefs.betaUpdates);
      clearTimeout(release);
      if (!found || (!manual && prefs.skipVersion === found.version)) {
        this.set({ phase: 'up-to-date', atLaunch: false, version: null });
        return;
      }
      const failedAt = this.readFailed()[found.version];
      const where = installation();
      const file = found.manifest.files?.[where.key];
      const asset = file && found.assets.find((a) => a.name === file.name);
      const base = { version: found.version, releaseUrl: found.releaseUrl };
      if (!file || !asset || where.method === 'manual' || !where.writable) {
        this.set({ ...base, phase: 'manual', atLaunch: false });
        return;
      }
      this.found = { ...found, where, file: { ...file, url: asset.browser_download_url } };
      if (!prefs.autoUpdate && !manual) {
        this.set({ ...base, phase: 'available', atLaunch: false });
        return;
      }
      if (!manual && failedAt && Date.now() - failedAt < RETRY_FAILED_AFTER_MS) {
        this.set({ ...base, phase: 'available', atLaunch: false });
        return;
      }
      await this.download();
      if (this.state.atLaunch && !this.state.deferred) await this.install();
      else this.set({ phase: 'ready', atLaunch: false });
    } catch (err) {
      clearTimeout(release);
      this.set({ phase: 'error', error: err.message || String(err), atLaunch: false });
    } finally {
      this.busy = false;
    }
  }

  /** Downloads the release file and checks it against the signed manifest. */
  async download() {
    const { file, version } = this.found;
    fs.mkdirSync(this.dir, { recursive: true });
    const dest = path.join(this.dir, file.name);
    this.set({ phase: 'downloading', version, progress: 0 });
    const res = await fetchOk(file.url);
    const total = Number(res.headers.get('content-length')) || file.size || 0;
    const hash = crypto.createHash('sha256');
    const part = `${dest}.part`;
    const out = fs.createWriteStream(part);
    let received = 0;
    let shown = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
        const progress = total ? Math.min(1, received / total) : 0;
        if (progress - shown >= 0.01) {
          shown = progress;
          this.set({ progress });
        }
      }
    } finally {
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    }
    if (received !== file.size || hash.digest('hex') !== file.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('The download did not match its signed checksum, so it was thrown away.');
    }
    fs.renameSync(part, dest);
    this.downloaded = dest;
    this.set({ progress: 1 });
  }

  /** The person chose "Continue without updating" during launch. */
  defer() {
    this.set({ deferred: true, atLaunch: false });
  }

  skip(version) {
    this.setPref('skipVersion', version);
    if (this.state.version === version) this.set({ phase: 'up-to-date', version: null });
  }

  /** "Update" on the available notice: download, then install. */
  async downloadAndInstall() {
    if (this.busy) return;
    if (!this.found) {
      await this.run({ manual: true });
      return;
    }
    this.busy = true;
    try {
      if (!this.downloaded) await this.download();
      await this.install();
    } catch (err) {
      this.set({ phase: 'error', error: err.message || String(err) });
    } finally {
      this.busy = false;
    }
  }

  /** Puts the verified download in place and starts the new version. */
  async install() {
    const { where, version } = this.found;
    const archive = this.downloaded;
    if (!archive) throw new Error('Nothing has been downloaded yet.');
    this.set({ phase: 'installing', version });
    await fs.promises.writeFile(this.pendingFile, JSON.stringify({ version, at: Date.now() }));
    if (where.method === 'appimage') {
      // Replace the AppImage file with one rename on the same disk; the
      // running copy keeps its open file until it exits.
      const staged = `${where.target}.update`;
      fs.copyFileSync(archive, staged);
      fs.chmodSync(staged, 0o755);
      fs.renameSync(staged, where.target);
      fs.rmSync(archive, { force: true });
      this.beforeRestart();
      // Start the new AppImage directly. Electron's own relaunch helper runs
      // from inside this AppImage's mount, which vanishes as this copy exits.
      const args = process.argv.slice(1).filter((a) => a !== '--hidden' && a !== '--after-update');
      const env = { ...process.env };
      for (const name of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[name];
      startDetached(where.target, [...args, '--after-update'], env);
      app.exit(0);
      return;
    }
    const parent = path.dirname(where.target);
    const staging = path.join(parent, `.pravda-update-${version}`);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const unpack = process.platform === 'darwin'
      ? spawnSync('ditto', ['-x', '-k', archive, staging])
      : spawnSync('tar', ['-xf', archive, '-C', staging], { windowsHide: true });
    if (unpack.status !== 0) throw new Error('The update could not be unpacked.');
    let fresh;
    if (where.method === 'bundle') {
      fresh = path.join(staging, 'Pravda.app');
    } else {
      const top = fs.readdirSync(staging).filter((n) => !n.startsWith('.'));
      if (top.length !== 1) throw new Error('The update archive has an unexpected layout.');
      fresh = path.join(staging, top[0]);
    }
    if (!fs.existsSync(fresh)) throw new Error('The update archive has an unexpected layout.');
    this.spawnSwap(where, fresh, staging);
    this.beforeRestart();
    app.quit();
  }

  /** A helper that waits for Pravda to quit, swaps folders and starts it. */
  spawnSwap(where, fresh, staging) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (process.platform === 'win32') {
      const script = path.join(this.dir, 'apply-update.ps1');
      fs.writeFileSync(script, [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `Wait-Process -Id ${process.pid} -Timeout 120`,
        'Start-Sleep -Milliseconds 500',
        `$target = ${psQuote(where.target)}`,
        `$fresh = ${psQuote(fresh)}`,
        '$old = "$target.old"',
        'Remove-Item -LiteralPath $old -Recurse -Force',
        'for ($i = 0; $i -lt 40; $i++) { try { Move-Item -LiteralPath $target -Destination $old -ErrorAction Stop; break } catch { Start-Sleep -Milliseconds 500 } }',
        'if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $target)) {',
        '  try { Move-Item -LiteralPath $fresh -Destination $target -ErrorAction Stop; Remove-Item -LiteralPath $old -Recurse -Force }',
        '  catch { Move-Item -LiteralPath $old -Destination $target }',
        '}',
        "Start-Process -FilePath (Join-Path $target 'Pravda.exe')",
        `Remove-Item -LiteralPath ${psQuote(staging)} -Recurse -Force`,
      ].join('\r\n'));
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
      return;
    }
    const launch = process.platform === 'darwin' ? `open ${quote(where.target)}` : `${quote(path.join(where.target, 'pravda'))} >/dev/null 2>&1 &`;
    const script = path.join(this.dir, 'apply-update.sh');
    fs.writeFileSync(script, [
      '#!/bin/sh',
      '# Waits for Pravda to quit, swaps in the new version and starts it.',
      `i=0; while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; i=$((i+1)); [ $i -gt 600 ] && exit 1; done`,
      `target=${quote(where.target)}`,
      `fresh=${quote(fresh)}`,
      'old="$target.old-$$"',
      'if mv "$target" "$old"; then',
      '  if mv "$fresh" "$target"; then rm -rf "$old"; else mv "$old" "$target"; fi',
      'fi',
      process.platform === 'darwin' ? 'xattr -dr com.apple.quarantine "$target" 2>/dev/null' : ':',
      launch,
      `rm -rf ${quote(staging)}`,
      '',
    ].join('\n'), { mode: 0o755 });
    startDetached('/bin/sh', [script], process.env);
  }
}

module.exports = { Updater, parseVersion, compareVersions, installation, RELEASES_PAGE };
