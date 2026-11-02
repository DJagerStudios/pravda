// Signing in, signing up, the authenticator, unlocking keys and recovery.
//
// Passwords never leave this device: they are stretched here, and only the
// derived "auth key" is sent. The private keys arrive sealed and are opened
// locally. See docs/SECURITY.md.

import { html, classes, useEffect, useRef, useState } from '../lib.js';
import { api, ApiError, isDesktop, setToken } from '../api.js';
import { S, update } from '../state.js';
import * as C from '../crypto.js';
import { adoptIdentity } from '../keys.js';
import { acceptInvite, previewInvite } from '../actions.js';
import { Button, Field } from './common.js';
import { Logo } from '../icons.js';
import { Poster, Slogan } from './brand.js';

const inviteFragment = () => (location.hash.length > 1 ? location.hash.slice(1) : null);

function Shell({ children, wide }) {
  return html`<main class="auth">
    <section class="auth-poster">
      <${Poster} />
      <${Slogan} />
    </section>
    <section class=${classes('auth-panel', wide && 'wide')}>
      <div class="auth-brand"><${Logo} size=${52} /><div>
        <h1>${S.instance?.name ?? 'Pravda'}</h1>
        <div class="auth-tag">Encrypted chat · Voice · Video</div>
      </div></div>
      ${children}
    </section>
  </main>`;
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

function CodeInput({ value, onInput, label = 'Six-digit code', autofocus = true }) {
  return html`<${Field} label=${label}>
    <input class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"
      data-autofocus=${autofocus || null} value=${value} onInput=${(e) => onInput(e.currentTarget.value.replace(/\D/g, ''))} />
  <//>`;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Shows a secret once, and insists it was saved before continuing. */
function SecretSheet({ title, intro, lines, filename, onDone, confirm }) {
  const [saved, setSaved] = useState(false);
  const text = lines.join('\n');
  return html`<div class="secret-sheet">
    <h2>${title}</h2>
    <p>${intro}</p>
    <pre class="secret-block" tabindex="0">${text}</pre>
    <div class="row-buttons">
      <${Button} onClick=${() => navigator.clipboard?.writeText(text)}>Copy<//>
      <${Button} onClick=${() => download(filename, `${title}\n${S.instance?.name ?? 'Pravda'} · @${S.me?.username ?? ''}\n\n${text}\n`)}>Download<//>
    </div>
    <label class="check"><input type="checkbox" checked=${saved} onChange=${(e) => setSaved(e.currentTarget.checked)} /> ${confirm}</label>
    <${Button} kind="primary" class="auth-submit" disabled=${!saved} onClick=${onDone}>Continue<//>
  </div>`;
}

/** Opens a sealed key bundle and makes the identity this device's. */
async function unlock(userId, bundle, wrapKey) {
  let keys;
  try {
    keys = await C.openBundle(bundle, wrapKey);
  } catch {
    throw new Error('Those details do not open your keys.');
  }
  await adoptIdentity(userId, keys);
}

async function finishSignIn(res, wrapKey, onSignedIn) {
  if (res.token) await setToken(res.token);
  S.me = res.user;
  S.stage = res.stage;
  await unlock(res.user.id, res.bundle.bundle, wrapKey);
  onSignedIn(res.stage);
}

function LoginForm({ onSignedIn, onRegister, onRecover, canRegister }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [mfa, setMfa] = useState(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const { busy, error, run } = useBusy();
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const pre = await api.post('/auth/prelogin', { username: form.username });
      const { authKey, wrapKey } = await C.stretchPassword(form.password, pre.kdf_salt, pre.kdf_iterations);
      const res = await api.post('/auth/login', { username: form.username, auth_key: authKey });
      if (res.mfa_required) setMfa({ ticket: res.ticket, wrapKey });
      else await finishSignIn(res, wrapKey, onSignedIn);
    });
  };
  const submitCode = (e) => {
    e.preventDefault();
    run(async () => {
      const body = useRecovery ? { ticket: mfa.ticket, recovery_code: code } : { ticket: mfa.ticket, code };
      const res = await api.post('/auth/login/mfa', body);
      await finishSignIn(res, mfa.wrapKey, onSignedIn);
    });
  };

  if (mfa) {
    return html`<form onSubmit=${submitCode}>
      <h2>Two-step verification</h2>
      <p class="auth-note">${useRecovery ? 'Enter one of the recovery codes you saved. Each works once.' : 'Open your authenticator app and enter the current code for Pravda.'}</p>
      ${useRecovery
        ? html`<${Field} label="Recovery code"><input data-autofocus autocapitalize="characters" spellcheck="false" value=${code} onInput=${(e) => setCode(e.currentTarget.value)} /><//>`
        : html`<${CodeInput} value=${code} onInput=${setCode} />`}
      ${error && html`<p class="form-error" role="alert">${error}</p>`}
      <${Button} kind="primary" type="submit" class="auth-submit" disabled=${busy || (!useRecovery && code.length !== 6)}>${busy ? 'Checking…' : 'Verify'}<//>
      <button type="button" class="link" onClick=${() => { setUseRecovery(!useRecovery); setCode(''); }}>
        ${useRecovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code'}
      </button>
    </form>`;
  }
  return html`<form onSubmit=${submit}>
    <${Field} label="Username">
      <input data-autofocus required autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="32" value=${form.username} onInput=${set('username')} />
    <//>
    <${Field} label="Password">
      <input required type="password" autocomplete="current-password" value=${form.password} onInput=${set('password')} />
    <//>
    ${error && html`<p class="form-error" role="alert">${error}</p>`}
    <${Button} kind="primary" type="submit" class="auth-submit" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}<//>
    <div class="auth-links">
      ${canRegister && html`<button type="button" class="link" onClick=${onRegister}>New here? Create an account</button>`}
      <button type="button" class="link" onClick=${onRecover}>Forgot your password?</button>
    </div>
  </form>`;
}

function RegisterForm({ onRegistered, onLogin, code, firstRun }) {
  const [form, setForm] = useState({ username: '', display_name: '', password: '', confirm: '' });
  const { busy, error, setError, run } = useBusy();
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });
  const submit = (e) => {
    e.preventDefault();
    if (form.password.length < 10) {
      setError('Use at least 10 characters. A few unrelated words make a strong password.');
      return;
    }
    if (form.password !== form.confirm) {
      setError('The passwords do not match.');
      return;
    }
    run(async () => {
      const identity = await C.generateIdentity();
      const salt = C.toB64(C.randomBytes(16));
      const { authKey, wrapKey } = await C.stretchPassword(form.password, salt, C.KDF_ITERATIONS);
      const recovery = C.newRecoveryKey();
      const recoverySecrets = await C.recoverySecrets(recovery.raw);
      const res = await api.post('/auth/register', {
        username: form.username,
        display_name: form.display_name,
        auth_key: authKey,
        kdf_salt: salt,
        kdf_iterations: C.KDF_ITERATIONS,
        sign_key: identity.signPub,
        dh_key: identity.dhPub,
        bundle: await C.sealBundle(identity, wrapKey),
        recovery_bundle: await C.sealBundle(identity, recoverySecrets.wrapKey),
        recovery_auth: recoverySecrets.authKey,
        invite: code ?? undefined,
      });
      if (res.token) await setToken(res.token);
      S.me = res.user;
      S.stage = res.stage;
      // Re-open the bundle so the stored copies are non-extractable.
      const fresh = await C.openBundle(await C.sealBundle(identity, wrapKey), wrapKey);
      await adoptIdentity(res.user.id, fresh);
      onRegistered(res.stage, recovery.text);
    });
  };
  return html`<form onSubmit=${submit}>
    ${firstRun && html`<p class="auth-note">This instance is brand new. The first account created runs it.</p>`}
    <${Field} label="Username" hint="2 to 32 letters, digits, dots, dashes or underscores.">
      <input data-autofocus required autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="32" value=${form.username} onInput=${set('username')} />
    <//>
    <${Field} label="Display name" hint="Optional. You can change it later.">
      <input autocomplete="nickname" maxlength="32" value=${form.display_name} onInput=${set('display_name')} />
    <//>
    <${Field} label="Password" hint="At least 10 characters. It never leaves this device.">
      <input required type="password" autocomplete="new-password" value=${form.password} onInput=${set('password')} />
    <//>
    <${Field} label="Password again">
      <input required type="password" autocomplete="new-password" value=${form.confirm} onInput=${set('confirm')} />
    <//>
    ${error && html`<p class="form-error" role="alert">${error}</p>`}
    <${Button} kind="primary" type="submit" class="auth-submit" disabled=${busy}>${busy ? 'Creating your keys…' : 'Create account'}<//>
    ${!firstRun && html`<div class="auth-links"><button type="button" class="link" onClick=${onLogin}>Already have an account? Sign in</button></div>`}
  </form>`;
}

function RecoverForm({ onSignedIn, onLogin }) {
  const [form, setForm] = useState({ username: '', recovery: '', code: '', password: '', confirm: '' });
  const [stage, setStage] = useState(null);
  const { busy, error, setError, run } = useBusy();
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });
  const start = (e) => {
    e.preventDefault();
    run(async () => {
      const raw = C.parseRecoveryKey(form.recovery);
      const secrets = await C.recoverySecrets(raw);
      const code = form.code.replace(/\s/g, '');
      const res = await api.post('/auth/recover', {
        username: form.username, recovery_auth: secrets.authKey,
        ...(/^\d{6}$/.test(code) ? { code } : code ? { recovery_code: code } : {}),
      });
      let keys;
      try {
        keys = await C.openBundle(res.recovery_bundle, secrets.wrapKey, { extractable: true });
      } catch {
        throw new Error('That recovery key does not open your keys.');
      }
      setStage({ ticket: res.ticket, keys });
    });
  };
  const finish = (e) => {
    e.preventDefault();
    if (form.password.length < 10 || form.password !== form.confirm) {
      setError('Choose a new password of at least 10 characters, typed the same twice.');
      return;
    }
    run(async () => {
      const salt = C.toB64(C.randomBytes(16));
      const { authKey, wrapKey } = await C.stretchPassword(form.password, salt, C.KDF_ITERATIONS);
      const bundle = await C.sealBundle(stage.keys, wrapKey);
      const res = await api.post('/auth/recover/complete', {
        ticket: stage.ticket, new_auth_key: authKey, kdf_salt: salt, kdf_iterations: C.KDF_ITERATIONS, bundle,
      });
      await finishSignIn({ ...res, bundle: { bundle } }, wrapKey, onSignedIn);
    });
  };
  if (stage) {
    return html`<form onSubmit=${finish}>
      <h2>Choose a new password</h2>
      <p class="auth-note">Your keys are open. Every other device will be signed out.</p>
      <${Field} label="New password"><input data-autofocus required type="password" autocomplete="new-password" value=${form.password} onInput=${set('password')} /><//>
      <${Field} label="New password again"><input required type="password" autocomplete="new-password" value=${form.confirm} onInput=${set('confirm')} /><//>
      ${error && html`<p class="form-error" role="alert">${error}</p>`}
      <${Button} kind="primary" type="submit" class="auth-submit" disabled=${busy}>Save and sign in<//>
    </form>`;
  }
  return html`<form onSubmit=${start}>
    <h2>Recover your account</h2>
    <p class="auth-note">You need the recovery key you saved when you joined, and your authenticator code or one of your recovery codes.</p>
    <${Field} label="Username"><input data-autofocus required autocomplete="username" autocapitalize="off" spellcheck="false" value=${form.username} onInput=${set('username')} /><//>
    <${Field} label="Recovery key"><textarea required rows="3" spellcheck="false" class="mono" value=${form.recovery} onInput=${set('recovery')}></textarea><//>
    <${Field} label="Authenticator code or recovery code"><input autocomplete="one-time-code" spellcheck="false" value=${form.code} onInput=${set('code')} /><//>
    ${error && html`<p class="form-error" role="alert">${error}</p>`}
    <${Button} kind="primary" type="submit" class="auth-submit" disabled=${busy}>${busy ? 'Checking…' : 'Continue'}<//>
    <div class="auth-links"><button type="button" class="link" onClick=${onLogin}>Back to sign in</button></div>
  </form>`;
}

/** Setting up the authenticator app, then showing backup codes once. */
export function EnrollPanel({ onDone }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const { busy, error, run } = useBusy();
  useEffect(() => {
    run(async () => setSetup(await api.post('/auth/totp/setup', {})));
  }, []);
  const enable = (e) => {
    e.preventDefault();
    run(async () => setCodes((await api.post('/auth/totp/enable', { code })).recovery_codes));
  };
  if (codes) {
    return html`<${SecretSheet} title="Pravda recovery codes" filename="pravda-recovery-codes.txt" lines=${codes}
      intro="If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe and offline."
      confirm="I have stored these codes somewhere safe." onDone=${onDone} />`;
  }
  return html`<form onSubmit=${enable} class="enroll">
    <h2>Set up your authenticator</h2>
    <p class="auth-note">Every account here is protected by a second step. Scan this with Google Authenticator, Microsoft Authenticator, Aegis, 2FAS or any app that supports TOTP.</p>
    ${setup ? html`<div class="enroll-grid">
      <img class="qr" src=${setup.qr} alt="QR code for your authenticator app" width="198" height="198" />
      <div>
        <div class="field-label">Can't scan? Enter this key</div>
        <code class="secret-inline">${setup.secret.match(/.{1,4}/g).join(' ')}</code>
      </div>
    </div>` : html`<div class="enroll-grid placeholder">Generating a secret…</div>`}
    <${CodeInput} value=${code} onInput=${setCode} autofocus=${false} />
    ${error && html`<p class="form-error" role="alert">${error}</p>`}
    <${Button} kind="primary" type="submit" class="auth-submit" disabled=${busy || code.length !== 6 || !setup}>Confirm<//>
  </form>`;
}

export function EnrollScreen({ onDone }) {
  return html`<${Shell}><${EnrollPanel} onDone=${onDone} /><//>`;
}

export function AuthScreen({ onSignedIn }) {
  const code = S.route.kind === 'invite' ? S.route.code : null;
  const firstRun = S.instance?.first_run;
  const canRegister = firstRun || S.instance?.registration === 'open' || (S.instance?.registration === 'invite' && code);
  const [mode, setMode] = useState(firstRun || code ? 'register' : 'login');
  const [recoveryKey, setRecoveryKey] = useState(null);
  const [enrolling, setEnrolling] = useState(false);
  const [invite, setInvite] = useState(null);

  useEffect(() => {
    if (code) previewInvite(code, inviteFragment()).then(setInvite).catch(() => {});
  }, [code]);

  if (recoveryKey) {
    return html`<${Shell}><${SecretSheet} title="Your recovery key" filename="pravda-recovery-key.txt" lines=${[recoveryKey]}
      intro="This key can reopen your encrypted messages and reset your password if you ever forget it. Nobody, including the people running this server, can do that for you."
      confirm="I have saved my recovery key somewhere safe."
      onDone=${() => { setRecoveryKey(null); if (S.stage === 'enroll') setEnrolling(true); else onSignedIn('full'); }} /><//>`;
  }
  if (enrolling) return html`<${EnrollScreen} onDone=${() => onSignedIn('full')} />`;

  return html`<${Shell}>
    ${invite && html`<div class="invite-card">
      <div class="invite-kicker">You have been invited to</div>
      <div class="invite-name">${invite.name ?? 'An encrypted server'}</div>
      <div class="invite-count">${invite.members} ${invite.members === 1 ? 'member' : 'members'} · ${invite.online} online</div>
    </div>`}
    ${mode === 'login' && html`<${LoginForm} canRegister=${canRegister} onSignedIn=${(stage) => (stage === 'enroll' ? setEnrolling(true) : onSignedIn(stage))}
      onRegister=${() => setMode('register')} onRecover=${() => setMode('recover')} />`}
    ${mode === 'register' && html`<${RegisterForm} code=${code} firstRun=${firstRun} onLogin=${() => setMode('login')}
      onRegistered=${(_stage, key) => setRecoveryKey(key)} />`}
    ${mode === 'recover' && html`<${RecoverForm} onSignedIn=${onSignedIn} onLogin=${() => setMode('login')} />`}
    ${mode !== 'recover' && !firstRun && !canRegister && html`<p class="auth-note">New accounts on this instance need an invite link.</p>`}
  <//>`;
}

/** This device has a session but not the keys: ask for the password once. */
export function UnlockScreen({ onUnlocked, onSignOut }) {
  const [password, setPassword] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const { busy, error, run } = useBusy();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const bundle = await api.get('/users/@me/bundle');
      if (useRecovery) {
        const secrets = await C.recoverySecrets(C.parseRecoveryKey(password));
        await unlock(S.me.id, bundle.recovery_bundle, secrets.wrapKey);
      } else {
        const { wrapKey } = await C.stretchPassword(password, bundle.kdf_salt, bundle.kdf_iterations);
        await unlock(S.me.id, bundle.bundle, wrapKey);
      }
      onUnlocked();
    });
  };
  return html`<${Shell}><form onSubmit=${submit}>
    <h2>Unlock your keys</h2>
    <p class="auth-note">Signed in as <strong>@${S.me?.username}</strong>. This device needs your ${useRecovery ? 'recovery key' : 'password'} once to open your encrypted messages.</p>
    ${useRecovery
      ? html`<${Field} label="Recovery key"><textarea data-autofocus required rows="3" class="mono" spellcheck="false" value=${password} onInput=${(e) => setPassword(e.currentTarget.value)}></textarea><//>`
      : html`<${Field} label="Password"><input data-autofocus required type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} /><//>`}
    ${error && html`<p class="form-error" role="alert">${error}</p>`}
    <${Button} kind="primary" type="submit" class="auth-submit" disabled=${busy}>${busy ? 'Unlocking…' : 'Unlock'}<//>
    <div class="auth-links">
      <button type="button" class="link" onClick=${() => { setUseRecovery(!useRecovery); setPassword(''); }}>${useRecovery ? 'Use my password' : 'Use my recovery key'}</button>
      <button type="button" class="link" onClick=${onSignOut}>Sign out</button>
    </div>
  </form><//>`;
}

/** Signed-in users opening an invite link. */
export function InviteLanding({ onDone }) {
  const code = S.route.code;
  const fragment = useRef(inviteFragment());
  const [invite, setInvite] = useState(null);
  const [password, setPassword] = useState('');
  const { busy, error, setError, run } = useBusy();
  useEffect(() => {
    previewInvite(code, fragment.current).then(setInvite).catch(() => setError('This invite has expired or been revoked.'));
  }, [code]);
  const accept = (e) => {
    e?.preventDefault();
    run(async () => onDone(await acceptInvite(code, fragment.current, password)));
  };
  const gated = invite && invite.gate !== 'none';
  return html`<main class="invite-landing">
    <form class="invite-sheet" onSubmit=${accept}>
      <${Logo} size=${64} />
      ${invite && html`<div class="invite-card">
        <div class="invite-kicker">You have been invited to</div>
        <div class="invite-name">${invite.name ?? 'An encrypted server'}</div>
        <div class="invite-count">${invite.members} ${invite.members === 1 ? 'member' : 'members'} · ${invite.online} online</div>
      </div>`}
      ${invite && !invite.name && html`<p class="auth-note">This link is missing its key, so the server's name stays hidden. You can still join; a member will share the key with you.</p>`}
      ${gated && html`<${Field} label=${invite.gate === 'rotating' ? 'Current join code' : 'Server password'}
        hint=${invite.gate === 'rotating' ? 'Ask a member for the code that is showing right now.' : 'This server requires a password.'}>
        <input data-autofocus required value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} autocomplete="off" />
      <//>`}
      ${error && html`<p class="form-error" role="alert">${error}</p>`}
      <div class="invite-actions">
        ${invite && html`<${Button} kind="primary" type="submit" disabled=${busy || (gated && !password)}>Accept invite<//>`}
        <${Button} onClick=${() => { onDone(null); update(); }}>Not now<//>
      </div>
    </form>
  </main>`;
}

/** Desktop app: choose, add or host a Pravda server. */
export function InstancePicker({ onChosen }) {
  const desktop = globalThis.pravdaDesktop;
  const [list, setList] = useState([]);
  const [url, setUrl] = useState('');
  const [hosting, setHosting] = useState(null);
  const { busy, error, run } = useBusy();
  useEffect(() => {
    desktop.listInstances().then(setList);
    desktop.hostStatus?.().then(setHosting);
  }, []);
  const add = (e) => {
    e.preventDefault();
    run(async () => {
      let target = url.trim();
      if (!/^https?:\/\//.test(target)) target = `https://${target}`;
      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        throw new Error('That is not a server address.');
      }
      // The desktop shell checks the server and asks before trusting a
      // certificate that no authority signed.
      const checked = await desktop.checkServer(parsed.origin);
      if (!checked.ok) throw new Error(checked.error);
      await desktop.addInstance({ url: checked.origin, name: checked.name });
      const invite = /^\/invite\/[\w-]+$/.test(parsed.pathname) ? `${parsed.pathname}${parsed.hash}` : null;
      onChosen(checked.origin, invite);
    });
  };
  // Starting a server shows the address and fingerprint friends need before
  // opening it.
  const host = () => run(async () => {
    const status = await desktop.startHosting();
    await desktop.addInstance({ url: status.url, name: 'This computer' });
    setHosting(status);
  });
  return html`<${Shell} wide><div class="instances">
    <h2>Choose a server</h2>
    <p class="auth-note">Pravda servers are run by communities themselves. Connect to one you were invited to, or host one on this computer.</p>
    ${list.length > 0 && html`<ul class="pick-list">
      ${list.map((i) => html`<li key=${i.url}><button class="pick" onClick=${() => onChosen(i.url)}>
        <span>${i.name}</span><small>${i.url}</small>
      </button></li>`)}
    </ul>`}
    <form onSubmit=${add}>
      <${Field} label="Server address" hint="For example pravda.example.org, or an invite link.">
        <input data-autofocus=${list.length === 0 || null} required value=${url} onInput=${(e) => setUrl(e.currentTarget.value)} spellcheck="false" autocapitalize="off" />
      <//>
      ${error && html`<p class="form-error" role="alert">${error}</p>`}
      <${Button} kind="primary" type="submit" disabled=${busy || !url.trim()}>Connect<//>
    </form>
    ${desktop.startHosting && html`<div class="host-box">
      <h3>Host a server here</h3>
      <p>Runs a Pravda server on this computer. Friends on your network can join right away. To reach friends over the internet, see HOSTING.md in the Pravda folder.</p>
      ${hosting?.running
        ? html`<div class="host-running">
            <p class="form-good">Your server is running.</p>
            ${hosting.lanUrls?.length > 0 && html`<p>Friends on your network connect to <strong class="mono">${hosting.lanUrls.join(', ')}</strong>.</p>`}
            ${hosting.fingerprint && html`<p>When their app asks, the fingerprint they should see is:</p><p class="mono fingerprint">${hosting.fingerprint}</p>`}
            <p class="field-hint">Your firewall must allow TCP port ${hosting.ports.web} and UDP and TCP port ${hosting.ports.media}.</p>
            <${Button} kind="primary" onClick=${() => onChosen(hosting.url)}>Open my server<//>
          </div>`
        : html`<${Button} disabled=${busy || hosting?.available === false} onClick=${host}>Start hosting<//>`}
      ${hosting?.available === false && html`<p class="field-hint">This build does not include the server.</p>`}
    </div>`}
  </div><//>`;
}

export { isDesktop };
