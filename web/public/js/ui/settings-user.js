// Your own settings: profile, security, audio and video, appearance, alerts.

import {
  html, classes, colorCss, formatStamp, useEffect, useRef, useState,
} from '../lib.js';
import { S, saveSettings, toast, update, openModal } from '../state.js';
import { api, upload } from '../api.js';
import { logout, report } from '../actions.js';
import * as C from '../crypto.js';
import { adoptIdentity, myFingerprint, rewrapBundle } from '../keys.js';
import { requestNotificationPermission } from '../notify.js';
import { Avatar, Button, Field, Modal, Toggle } from './common.js';
import { ProfileCard } from './members.js';
import { EnrollPanel } from './auth.js';
import { restartMic, setOutputDevice } from '../voice.js';

const desktop = globalThis.pravdaDesktop ?? null;

const PAGES = [
  ['profile', 'Profile'],
  ['security', 'Security'],
  ['voice', 'Voice and video'],
  ['appearance', 'Appearance'],
  ['accessibility', 'Accessibility'],
  ['alerts', 'Notifications'],
  desktop?.getPreferences && ['desktop', 'Desktop app'],
].filter(Boolean);

/** A row of mutually exclusive choices, announced as pressed or not. */
function Choices({ label, value, options, onChange }) {
  return html`<div class="choice-row" role="group" aria-label=${label}>
    ${options.map(([k, title, hint]) => html`
      <button key=${k} class=${classes('choice', value === k && 'active')} aria-pressed=${value === k} onClick=${() => onChange(k)}>
        <strong>${title}</strong><span>${hint}</span>
      </button>`)}
  </div>`;
}

const hex = (n) => colorCss(n) || '#000000';
const parseHex = (v) => parseInt(v.slice(1), 16);

function ProfilePage() {
  const me = S.me;
  const [form, setForm] = useState({
    display_name: me.display_name, pronouns: me.pronouns ?? '', bio: me.bio ?? '', custom_status: me.custom_status ?? '',
    accent_color: me.accent_color ?? 0, banner_color: me.banner_color ?? 0,
  });
  const [busy, setBusy] = useState(false);
  const avatarFile = useRef(null);
  const bannerFile = useRef(null);
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.patch('/users/@me', form);
      toast('Profile updated.');
    } catch (err) {
      report(err);
    }
    setBusy(false);
  };
  const pick = (field) => async (e) => {
    const chosen = e.currentTarget.files[0];
    e.currentTarget.value = '';
    if (!chosen) return;
    try {
      const up = await upload(chosen, { kind: 'public', name: chosen.name });
      await api.patch('/users/@me', { [field]: up.url });
    } catch (err) {
      report(err);
    }
  };
  const preview = { ...me, ...form };
  return html`<div class="profile-editor">
    <form onSubmit=${save}>
      <p class="settings-line">Your profile is visible to people you share a server with. Unlike your messages, it is not end-to-end encrypted.</p>
      <div class="image-row">
        <div class="avatar-edit">
          <${Avatar} userId=${me.id} size=${72} />
          <div class="avatar-edit-actions">
            <${Button} onClick=${() => avatarFile.current.click()}>Change avatar<//>
            ${me.avatar && html`<${Button} onClick=${() => api.patch('/users/@me', { avatar: '' }).catch(report)}>Remove<//>`}
          </div>
        </div>
        <div class="avatar-edit-actions">
          <${Button} onClick=${() => bannerFile.current.click()}>Banner image<//>
          ${me.banner && html`<${Button} onClick=${() => api.patch('/users/@me', { banner: '' }).catch(report)}>Remove banner<//>`}
        </div>
        <input ref=${avatarFile} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange=${pick('avatar')} />
        <input ref=${bannerFile} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange=${pick('banner')} />
      </div>
      <div class="field-pair">
        <${Field} label="Display name"><input required maxlength="32" value=${form.display_name} onInput=${set('display_name')} /><//>
        <${Field} label="Pronouns"><input maxlength="40" placeholder="they/them" value=${form.pronouns} onInput=${set('pronouns')} /><//>
      </div>
      <${Field} label="Status line" hint="A few words shown beside your name."><input maxlength="80" value=${form.custom_status} onInput=${set('custom_status')} /><//>
      <${Field} label="About you"><textarea rows="4" maxlength="400" value=${form.bio} onInput=${set('bio')}></textarea><//>
      <div class="field-pair">
        <${Field} label="Banner colour" hint="Used when there is no banner image.">
          <input type="color" value=${hex(form.banner_color || 0xc8102e)} onInput=${(e) => setForm({ ...form, banner_color: parseHex(e.currentTarget.value) })} />
        <//>
        <${Field} label="Accent colour" hint="Frames your profile card.">
          <input type="color" value=${hex(form.accent_color || 0xc8102e)} onInput=${(e) => setForm({ ...form, accent_color: parseHex(e.currentTarget.value) })} />
        <//>
      </div>
      <${Button} kind="primary" type="submit" disabled=${busy}>Save<//>
    </form>
    <aside class="profile-preview" aria-label="Preview">
      <div class="field-label">Preview</div>
      <div class="popover static"><${ProfileCard} userId=${me.id} preview=${preview} /></div>
    </aside>
  </div>`;
}

function PasswordForm() {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (form.next.length < 10 || form.next !== form.confirm) {
      toast('Choose a new password of at least 10 characters, typed the same twice.', 'error');
      return;
    }
    setBusy(true);
    try {
      const bundle = await api.get('/users/@me/bundle');
      const old = await C.stretchPassword(form.current, bundle.kdf_salt, bundle.kdf_iterations);
      const salt = C.toB64(C.randomBytes(16));
      const fresh = await C.stretchPassword(form.next, salt, C.KDF_ITERATIONS);
      let sealed;
      try {
        sealed = await rewrapBundle(bundle.bundle, old.wrapKey, fresh.wrapKey);
      } catch {
        throw new Error('Your current password is wrong.');
      }
      await api.put('/users/@me/password', {
        auth_key: old.authKey, new_auth_key: fresh.authKey, kdf_salt: salt, kdf_iterations: C.KDF_ITERATIONS, bundle: sealed,
      });
      setForm({ current: '', next: '', confirm: '' });
      toast('Password changed. Your other devices were signed out.');
    } catch (err) {
      report(err);
    }
    setBusy(false);
  };
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });
  return html`<form onSubmit=${submit}>
    <${Field} label="Current password"><input type="password" required autocomplete="current-password" value=${form.current} onInput=${set('current')} /><//>
    <div class="field-pair">
      <${Field} label="New password"><input type="password" required minlength="10" autocomplete="new-password" value=${form.next} onInput=${set('next')} /><//>
      <${Field} label="New password again"><input type="password" required autocomplete="new-password" value=${form.confirm} onInput=${set('confirm')} /><//>
    </div>
    <${Button} type="submit" disabled=${busy}>${busy ? 'Re-encrypting your keys…' : 'Change password'}<//>
  </form>`;
}

function SecurityPage() {
  const [fp, setFp] = useState('');
  const [sessions, setSessions] = useState(null);
  const [moving, setMoving] = useState(false);
  const load = () => api.get('/users/@me/sessions').then(setSessions).catch(report);
  useEffect(() => {
    load();
    myFingerprint().then(setFp).catch(() => {});
  }, []);
  const revoke = async (id) => {
    try {
      await api.del(`/users/@me/sessions/${id}`);
      load();
    } catch (err) {
      report(err);
    }
  };
  const regenerate = () => openModal('codesReset');
  return html`<div>
    <h3>Your encryption identity</h3>
    <p class="settings-line">Others can compare this fingerprint with what they see on your profile to be sure nobody is intercepting your messages.</p>
    <code class="fingerprint">${fp || '…'}</code>
    <h3>Authenticator</h3>
    ${moving
      ? html`<${EnrollPanel} onDone=${() => { setMoving(false); toast('Authenticator moved.'); }} />`
      : html`<p class="settings-line">${S.me.totp_enabled ? 'Your account asks for a code from your authenticator app at every sign-in.' : 'No authenticator is set up.'}</p>
        <div class="row-buttons">
          <${Button} onClick=${() => setMoving(true)}>${S.me.totp_enabled ? 'Move to a new phone' : 'Set up an authenticator'}<//>
          ${S.me.totp_enabled && html`<${Button} onClick=${regenerate}>New recovery codes<//>`}
        </div>`}
    <h3>Password</h3>
    <${PasswordForm} />
    <h3>Signed-in devices</h3>
    <ul class="session-list">
      ${sessions?.sessions.map((s) => html`<li key=${s.id}>
        <span class="admin-text"><strong>${s.id === sessions.current ? 'This device' : 'Other device'}</strong><small>${s.label || 'Unknown'}</small><small>Last seen ${formatStamp(s.last_seen)}</small></span>
        ${s.id !== sessions.current && html`<${Button} onClick=${() => revoke(s.id)}>Sign out<//>`}
      </li>`)}
    </ul>
    <div class="row-buttons">
      <${Button} kind="danger" onClick=${logout}>Sign out of this device<//>
      <${Button} kind="danger" onClick=${() => openModal('resetKeys')}>Reset my keys<//>
    </div>
  </div>`;
}

/** Re-shows the authenticator challenge before issuing new recovery codes. */
export function CodesResetModal() {
  const [form, setForm] = useState({ password: '', code: '' });
  const [codes, setCodes] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    try {
      const bundle = await api.get('/users/@me/bundle');
      const { authKey } = await C.stretchPassword(form.password, bundle.kdf_salt, bundle.kdf_iterations);
      setCodes((await api.post('/auth/recovery-codes', { auth_key: authKey, code: form.code })).recovery_codes);
    } catch (err) {
      report(err);
    }
  };
  return html`<${Modal} title="New recovery codes" size="small">
    ${codes
      ? html`<p>Your old codes no longer work. Store these somewhere safe:</p><pre class="secret-block">${codes.join('\n')}</pre>`
      : html`<form onSubmit=${submit}>
        <${Field} label="Password"><input data-autofocus type="password" required value=${form.password} onInput=${(e) => setForm({ ...form, password: e.currentTarget.value })} /><//>
        <${Field} label="Authenticator code"><input inputmode="numeric" maxlength="6" required value=${form.code} onInput=${(e) => setForm({ ...form, code: e.currentTarget.value.replace(/\D/g, '') })} /><//>
        <${Button} kind="primary" type="submit">Generate new codes<//>
      </form>`}
  <//>`;
}

/** Starts a fresh identity. Everything sealed for the old one is lost. */
export function ResetKeysModal() {
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const bundle = await api.get('/users/@me/bundle');
      const { authKey, wrapKey } = await C.stretchPassword(password, bundle.kdf_salt, bundle.kdf_iterations);
      const identity = await C.generateIdentity();
      const key = C.newRecoveryKey();
      const secrets = await C.recoverySecrets(key.raw);
      await api.put('/users/@me/keys', {
        auth_key: authKey, sign_key: identity.signPub, dh_key: identity.dhPub,
        bundle: await C.sealBundle(identity, wrapKey), recovery_bundle: await C.sealBundle(identity, secrets.wrapKey),
      });
      const fresh = await C.openBundle(await C.sealBundle(identity, wrapKey), wrapKey);
      await adoptIdentity(S.me.id, fresh);
      S.me = { ...S.me, sign_key: identity.signPub, dh_key: identity.dhPub };
      S.users.set(S.me.id, S.me);
      setRecovery(key.text);
    } catch (err) {
      report(err);
    }
    setBusy(false);
  };
  return html`<${Modal} title="Reset my keys" size="small">
    ${recovery
      ? html`<p>Your new identity is ready. Others will see that your keys changed. Your new recovery key:</p>
        <pre class="secret-block">${recovery}</pre><p class="field-hint">Your old recovery key no longer works.</p>`
      : html`<form onSubmit=${submit}>
        <p>This makes a brand-new encryption identity. Messages you could read before stay unreadable to you unless others share their keys again, and everyone sees that your keys changed. Only do this if your keys were exposed.</p>
        <${Field} label="Password"><input data-autofocus type="password" required value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} /><//>
        <${Button} kind="danger" type="submit" disabled=${busy}>${busy ? 'Creating new keys…' : 'Reset my keys'}<//>
      </form>`}
  <//>`;
}

function MicMeter() {
  const [level, setLevel] = useState(null);
  const stop = useRef(null);
  const start = async () => {
    try {
      const audio = S.settings.inputDevice === 'default' ? true : { deviceId: { exact: S.settings.inputDevice } };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let frame = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(peak / 128);
        frame = requestAnimationFrame(tick);
      };
      tick();
      stop.current = () => {
        cancelAnimationFrame(frame);
        for (const t of stream.getTracks()) t.stop();
        ctx.close();
        stop.current = null;
        setLevel(null);
      };
    } catch {
      toast('The microphone could not be opened.', 'error');
    }
  };
  useEffect(() => () => stop.current?.(), []);
  return html`<div class="mic-test">
    <${Button} onClick=${() => (stop.current ? stop.current() : start())}>${level === null ? 'Test microphone' : 'Stop test'}<//>
    <div class="meter" role="progressbar" aria-label="Microphone level" aria-valuenow=${Math.round((level ?? 0) * 100)}>
      <div class="meter-fill" style=${{ width: `${Math.min(100, (level ?? 0) * 140)}%` }}></div>
    </div>
  </div>`;
}

function VoicePage() {
  const s = S.settings;
  const [devices, setDevices] = useState([]);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
  }, []);
  const options = (kind) => [
    html`<option key="default" value="default">System default</option>`,
    ...devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId)
      .map((d, i) => html`<option key=${d.deviceId} value=${d.deviceId}>${d.label || `Device ${i + 1}`}</option>`),
  ];
  const processing = (key) => (v) => {
    saveSettings({ [key]: v });
    restartMic();
  };
  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      saveSettings({ pttKey: e.code });
      setRecording(false);
    };
    addEventListener('keydown', onKey, { capture: true, once: true });
    return () => removeEventListener('keydown', onKey, { capture: true });
  }, [recording]);
  return html`<div>
    <p class="settings-line">Calls are end-to-end encrypted frame by frame. The server relays them without being able to hear or see anything.</p>
    <div class="field-pair">
      <${Field} label="Microphone"><select value=${s.inputDevice} onChange=${(e) => { saveSettings({ inputDevice: e.currentTarget.value }); restartMic(); }}>${options('audioinput')}</select><//>
      <${Field} label="Speakers"><select value=${s.outputDevice} onChange=${(e) => { saveSettings({ outputDevice: e.currentTarget.value }); setOutputDevice(e.currentTarget.value); }}>${options('audiooutput')}</select><//>
    </div>
    <${MicMeter} />
    <${Field} label="Camera"><select value=${s.cameraDevice} onChange=${(e) => saveSettings({ cameraDevice: e.currentTarget.value })}>${options('videoinput')}</select><//>
    <h3>Input mode</h3>
    <div class="choice-row">
      ${[['voice', 'Voice activity', 'Your microphone is live while unmuted'], ['ptt', 'Push to talk', 'Transmit only while holding a key']].map(([k, label, hint]) => html`
        <button key=${k} class=${classes('choice', s.inputMode === k && 'active')} aria-pressed=${s.inputMode === k} onClick=${() => saveSettings({ inputMode: k })}>
          <strong>${label}</strong><span>${hint}</span>
        </button>`)}
    </div>
    ${s.inputMode === 'ptt' && html`<div class="ptt-row">
      <${Button} onClick=${() => setRecording(true)}>${recording ? 'Press any key…' : `Key: ${s.pttKey.replace(/^Key/, '')}`}<//>
      <span class="field-hint">Works while Pravda is focused. In the desktop app, Ctrl+Shift+M and Ctrl+Shift+D mute and deafen from anywhere.</span>
    </div>`}
    <h3>Sound processing</h3>
    <${Toggle} label="Noise suppression" hint="Filters out fans, keyboards and street noise." checked=${s.noiseSuppression} onChange=${processing('noiseSuppression')} />
    <${Toggle} label="Echo cancellation" hint="Stops others hearing themselves through your speakers." checked=${s.echoCancellation} onChange=${processing('echoCancellation')} />
    <${Toggle} label="Automatic gain" hint="Keeps your volume steady." checked=${s.autoGainControl} onChange=${processing('autoGainControl')} />
    <h3>Screen sharing</h3>
    <${Field} label="Quality" hint="Higher settings need more upload bandwidth.">
      <select value=${s.streamQuality} onChange=${(e) => saveSettings({ streamQuality: e.currentTarget.value })}>
        <option value="720p30">720p, 30 fps</option>
        <option value="1080p30">1080p, 30 fps</option>
        <option value="1080p60">1080p, 60 fps</option>
        <option value="1440p60">1440p, 60 fps</option>
      </select>
    <//>
    <h3>Watching together</h3>
    <${Toggle} label="Load YouTube videos without asking" hint="YouTube plays through its privacy-enhanced player, but Google still sees your IP address." checked=${s.allowYouTube} onChange=${(v) => saveSettings({ allowYouTube: v })} />
    <${Toggle} label="Load linked videos without asking" hint="The site hosting the video sees your IP address." checked=${s.allowExternalMedia} onChange=${(v) => saveSettings({ allowExternalMedia: v })} />
  </div>`;
}

function AppearancePage() {
  const s = S.settings;
  return html`<div>
    <h3>Theme</h3>
    <${Choices} label="Theme" value=${s.theme} onChange=${(theme) => saveSettings({ theme })} options=${[
      ['system', 'System', 'Match your desktop'], ['day', 'Light', 'Black ink on cream'], ['night', 'Dark', 'Cream ink on black'],
    ]} />
    <${Toggle} label="Compact mode" hint="Fit more text on screen." checked=${s.compact} onChange=${(v) => saveSettings({ compact: v })} />
    <p class="settings-line">Text size, contrast, a more readable font and motion are under Accessibility.</p>
  </div>`;
}

function AccessibilityPage() {
  const s = S.settings;
  return html`<div>
    <h3>Contrast</h3>
    <${Choices} label="Contrast" value=${s.contrast} onChange=${(contrast) => saveSettings({ contrast })} options=${[
      ['system', 'System', 'Follow your system’s contrast setting'], ['standard', 'Standard', 'The usual three inks'], ['high', 'High', 'Stronger text, solid rules, thicker focus rings'],
    ]} />
    <h3>Reading</h3>
    <${Field} label=${`Text size: ${s.fontScale}%`} hint="Everything scales, and the layout keeps every word visible.">
      <input type="range" min="85" max="150" step="5" value=${s.fontScale} aria-valuetext=${`${s.fontScale} percent`}
        onInput=${(e) => saveSettings({ fontScale: Number(e.currentTarget.value) })} />
    <//>
    <${Toggle} label="Readable font" hint="Atkinson Hyperlegible, designed for people with low vision, everywhere, with no all-capital labels."
      checked=${s.readableFont} onChange=${(v) => saveSettings({ readableFont: v })} />
    <${Toggle} label="Show role colours on names" hint="Turn off to show every name in the normal text colour."
      checked=${s.roleColors} onChange=${(v) => saveSettings({ roleColors: v })} />
    <${Toggle} label="Always show message times" hint="Show the time beside every message, not only on hover."
      checked=${s.alwaysTimestamps} onChange=${(v) => saveSettings({ alwaysTimestamps: v })} />
    <h3>Motion</h3>
    <${Toggle} label="Reduce motion" hint="Skip the opening animation and other movement. Your system’s reduced-motion setting does the same."
      checked=${s.reduceMotion} onChange=${(v) => saveSettings({ reduceMotion: v })} />
    <h3>Screen readers</h3>
    <${Toggle} label="Read out new messages" hint="Announce each new message in the open channel as it arrives."
      checked=${s.announceMessages} onChange=${(v) => saveSettings({ announceMessages: v })} />
    <h3>Keyboard</h3>
    <p class="settings-line">Everything in Pravda works from the keyboard. Once a message has focus, the arrow keys move between messages and Tab reaches its actions.</p>
    <${Button} onClick=${() => openModal('shortcuts')}>Keyboard shortcuts<//>
  </div>`;
}

const UPDATE_TEXT = {
  idle: () => '',
  unsupported: () => 'Updates are off in copies run from the source code.',
  checking: () => 'Checking for updates…',
  'up-to-date': () => 'You have the latest version.',
  available: (u) => `Pravda ${u.version} is available.`,
  downloading: (u) => `Downloading Pravda ${u.version}: ${Math.round((u.progress ?? 0) * 100)}%.`,
  ready: (u) => `Pravda ${u.version} is downloaded and verified. Restart to finish.`,
  installing: (u) => `Installing Pravda ${u.version}…`,
  manual: (u) => `Pravda ${u.version} is available. This copy cannot update itself, so download it from the release page.`,
  error: (u) => `The last update check failed: ${u.error}`,
};

function DesktopPage() {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => { desktop.getPreferences().then(setPrefs); }, []);
  if (!prefs) return null;
  const set = (key) => async (value) => setPrefs(await desktop.setPreference(key, value));
  const u = S.update ?? { phase: 'idle' };
  const busy = ['checking', 'downloading', 'installing'].includes(u.phase);
  return html`<div>
    <h3>Starting up</h3>
    <${Toggle} label="Open Pravda when you log in" checked=${prefs.openAtLogin} onChange=${set('openAtLogin')} />
    <${Toggle} label="Start in the tray" hint="When Pravda opens at login, it waits in the tray until you need it."
      checked=${prefs.startMinimized} disabled=${!prefs.openAtLogin} onChange=${set('startMinimized')} />
    <${Toggle} label="Keep running in the tray when the window closes" hint="Calls and notifications continue. Quit from the tray or with Ctrl+Q."
      checked=${prefs.closeToTray} onChange=${set('closeToTray')} />
    <h3>Updates</h3>
    <p class="settings-line" role="status">This is Pravda ${desktop.version}. ${(UPDATE_TEXT[u.phase] ?? UPDATE_TEXT.idle)(u)}</p>
    <${Toggle} label="Install updates automatically" hint="Pravda checks when it starts and every few hours. Updates are verified against Pravda’s signing key before they are installed."
      checked=${prefs.autoUpdate} onChange=${set('autoUpdate')} />
    <${Toggle} label="Include beta versions" hint="Get new features early. Betas may have rough edges."
      checked=${prefs.betaUpdates} onChange=${set('betaUpdates')} />
    <div class="row-buttons">
      <${Button} onClick=${() => desktop.checkForUpdates()} disabled=${busy || u.phase === 'unsupported'}>Check for updates<//>
      ${u.phase === 'available' && html`<${Button} kind="primary" onClick=${() => desktop.downloadUpdate()}>Download and install<//>`}
      ${u.phase === 'ready' && html`<${Button} kind="primary" onClick=${() => desktop.installUpdate()}>Restart to update<//>`}
      ${u.phase === 'manual' && html`<a class="button button-primary" href=${u.releaseUrl} target="_blank" rel="noopener">Open the release page<//>`}
    </div>
  </div>`;
}

function AlertsPage() {
  const s = S.settings;
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  return html`<div>
    <h3>Desktop notifications</h3>
    <${Choices} label="Desktop notifications" value=${s.notifications} onChange=${(notifications) => saveSettings({ notifications })} options=${[
      ['all', 'All messages', 'Every new message'], ['mentions', 'Mentions', 'Only when you are mentioned'], ['none', 'Nothing', 'No notifications'],
    ]} />
    <p class="settings-line">This is the default. Right-click a server, channel or conversation to give it its own level or mute it.</p>
    <p class="settings-line">Notifications are decrypted on this device; nothing readable passes through any push service.</p>
    ${permission === 'default' && html`<${Button} onClick=${() => { requestNotificationPermission(); update(); }}>Allow desktop notifications<//>`}
    ${permission === 'denied' && html`<p class="field-hint">Notifications are blocked in your browser's site settings.</p>`}
    <${Toggle} label="Sounds" hint="Sounds for joining, muting and new messages." checked=${s.sounds} onChange=${(v) => saveSettings({ sounds: v })} />
  </div>`;
}

export function UserSettings({ page: initial }) {
  const [page, setPage] = useState(initial ?? 'profile');
  const Page = {
    profile: ProfilePage, security: SecurityPage, voice: VoicePage, appearance: AppearancePage,
    accessibility: AccessibilityPage, alerts: AlertsPage, desktop: DesktopPage,
  }[page] ?? ProfilePage;
  return html`<${Modal} title="Settings" size="large">
    <div class="settings">
      <nav class="settings-nav" aria-label="Settings pages">
        ${PAGES.map(([key, label]) => html`<button key=${key} class=${classes('settings-tab', page === key && 'active')}
          aria-current=${page === key ? 'page' : null} onClick=${() => setPage(key)}>${label}</button>`)}
      </nav>
      <div class="settings-page"><${Page} /></div>
    </div>
  <//>`;
}
