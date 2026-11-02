// Application entry: decides what fills the window.

import {
  html, render, classes, useEffect, useLayoutEffect, useState,
} from './lib.js';
import {
  S, closeModal, currentChannel, currentServer, dmTitle, openModal, subscribe, toast, update, user,
} from './state.js';
import { api, configure, isDesktop } from './api.js';
import { connect, disconnect } from './gateway.js';
import { navigate, startRouter } from './router.js';
import { requestNotificationPermission, syncTitle } from './notify.js';
import { bindPushToTalk, joinVoice, toggleDeafen, toggleMute } from './voice.js';
import { forgetIdentity, restoreIdentity } from './keys.js';
import { Icon } from './icons.js';
import { Avatar, Button, Popover, Menu, closePopover, IconButton, openPopover } from './ui/common.js';
import { QuickSwitcher } from './ui/switcher.js';
import { ShortcutsModal } from './ui/shortcuts.js';
import { markHereRead, stepChannel } from './navigation.js';
import {
  AuthScreen, EnrollScreen, InstancePicker, InviteLanding, UnlockScreen,
} from './ui/auth.js';
import { SplashArt } from './ui/brand.js';
import { Rail } from './ui/rail.js';
import { Sidebar } from './ui/sidebar.js';
import { Masthead, MessageList } from './ui/messages.js';
import { Composer } from './ui/composer.js';
import { Stage } from './ui/stage.js';
import { MemberList, ProfileCard } from './ui/members.js';
import { Friends } from './ui/friends.js';
import { SidePanel } from './ui/panels.js';
import { EmojiPicker } from './ui/pickers.js';
import { WatchModal } from './ui/cinema.js';
import {
  AddServerModal, ConfirmModal, CreateChannelModal, InviteModal, Lightbox, MemberRolesModal, NewDMModal, PromptModal, TTLModal,
} from './ui/modals.js';
import { CodesResetModal, ResetKeysModal, UserSettings } from './ui/settings-user.js';
import { ChannelSettings, ServerSettings } from './ui/settings-server.js';

const MODALS = {
  confirm: ConfirmModal,
  prompt: PromptModal,
  addServer: AddServerModal,
  createChannel: CreateChannelModal,
  invite: InviteModal,
  newDM: NewDMModal,
  memberRoles: MemberRolesModal,
  lightbox: Lightbox,
  userSettings: UserSettings,
  serverSettings: ServerSettings,
  channelSettings: ChannelSettings,
  watch: WatchModal,
  ttl: TTLModal,
  codesReset: CodesResetModal,
  resetKeys: ResetKeysModal,
  switcher: QuickSwitcher,
  shortcuts: ShortcutsModal,
};

const desktop = globalThis.pravdaDesktop ?? null;

const SPLASH_LINES = [
  'Starting up…',
  'Loading your keys…',
  'Connecting securely…',
];
const SPLASH_MINIMUM_MS = 1300;
const SPLASH_FADE_MS = 260; // matches .splash's opacity transition
const bootStarted = performance.now();

function CurrentModal() {
  if (!S.modal) return null;
  const Component = MODALS[S.modal.kind];
  return html`<${Component} key=${S.modal.kind} ...${S.modal.props} />`;
}

function CurrentPopover() {
  const p = S.popover;
  if (!p) return null;
  switch (p.kind) {
    case 'profile':
      return html`<${Popover} rect=${p.rect} width=${330}><${ProfileCard} ...${p.props} /><//>`;
    case 'menu':
      return html`<${Popover} rect=${p.rect} width=${240}><${Menu} items=${p.props.items} /><//>`;
    case 'emoji':
      return html`<${Popover} rect=${p.rect} width=${320}><${EmojiPicker} onPick=${p.props.onPick} /><//>`;
    default:
      return null;
  }
}

function Toast() {
  if (!S.toast) return null;
  return html`<div class=${classes('toast', S.toast.kind === 'error' && 'error')} role="status">${S.toast.message}</div>`;
}

function Banners() {
  const changes = [...S.keyChanges];
  return html`
    ${S.connection === 'reconnecting' && html`<div class="banner" role="status">Connection lost. Reconnecting…</div>`}
    ${changes.length > 0 && html`<div class="banner warning" role="status">
      <span><${Icon} name="key" size=${14} /> Security keys changed for ${changes.map((id) => user(id).display_name).join(', ')}.</span>
      <button class="link" onClick=${(e) => openPopover('profile', e.currentTarget, { userId: changes[0] })}>Verify</button>
    </div>`}`;
}

/** The desktop app's update notices: ready to install, available, or manual. */
function UpdateBanner() {
  const u = S.update;
  if (!u || !u.version || S.updateDismissed === u.version) return null;
  const later = () => { S.updateDismissed = u.version; update(); };
  if (u.phase === 'ready') {
    return html`<div class="banner update" role="status">
      <span>Pravda ${u.version} is ready to install.</span>
      <button class="link" onClick=${() => desktop.installUpdate()}>Restart now</button>
      <button class="link" onClick=${later}>Later</button>
    </div>`;
  }
  if (u.phase === 'available') {
    return html`<div class="banner update" role="status">
      <span>Pravda ${u.version} is available.</span>
      <button class="link" onClick=${() => desktop.downloadUpdate()}>Update</button>
      <button class="link" onClick=${later}>Later</button>
      <button class="link" onClick=${() => { desktop.skipUpdate(u.version); later(); }}>Skip this version</button>
    </div>`;
  }
  if (u.phase === 'manual') {
    return html`<div class="banner update" role="status">
      <span>Pravda ${u.version} is available. This copy cannot update itself.</span>
      <a class="link" href=${u.releaseUrl} target="_blank" rel="noopener">Download it</a>
      <button class="link" onClick=${later}>Later</button>
    </div>`;
  }
  if (u.phase === 'error' && u.installFailed) {
    return html`<div class="banner warning" role="status">
      <span>The update to Pravda ${u.version} could not be installed: ${u.error}</span>
      <button class="link" onClick=${later}>Dismiss</button>
    </div>`;
  }
  return null;
}

function RingBanner() {
  if (!S.ring) return null;
  const c = S.channels.get(S.ring.channel_id);
  return html`<div class="ring" role="alertdialog" aria-label="Incoming call">
    <${Avatar} userId=${S.ring.from} size=${56} />
    <div class="ring-text">
      <div class="ring-kicker">Incoming encrypted call</div>
      <strong>${c ? dmTitle(c) : user(S.ring.from).display_name}</strong>
    </div>
    <div class="ring-actions">
      <${Button} kind="primary" onClick=${() => {
        const id = S.ring.channel_id;
        S.ring = null;
        navigate(`/channels/@me/${id}`);
        joinVoice(id);
      }}>Answer<//>
      <${Button} onClick=${() => { S.ring = null; update(); }}>Decline<//>
    </div>
  </div>`;
}

function ChatView({ c }) {
  return html`<main class="chat">
    <div class="sr-only" aria-live="polite" aria-atomic="true">${S.announcement && html`<span key=${S.announcement.key}>${S.announcement.text}</span>`}</div>
    <${Masthead} c=${c} />
    <${Stage} c=${c} compact />
    <div class="chat-columns">
      <section class="chat-main">
        <${MessageList} key=${c.id} c=${c} />
        <${Composer} c=${c} />
      </section>
      ${S.panel && html`<${SidePanel} c=${c} />`}
      ${!S.panel && S.settings.showMembers && c.server_id !== '0' && html`<${MemberList} srv=${S.servers.get(c.server_id)} />`}
    </div>
  </main>`;
}

function NoChannels({ srv }) {
  return html`<main class="chat no-channels">
    <header class="masthead">
      <${IconButton} class="drawer-toggle" icon="menu" label="Channels" onClick=${() => { S.railOpen = !S.railOpen; update(); }} />
      <div class="masthead-title"><h1>${srv.name}</h1></div>
    </header>
    <div class="empty-state"><div class="empty-star"><${Icon} name="star" size=${44} /></div>
      <h3>No channels available</h3><p>Ask a moderator for access.</p></div>
  </main>`;
}

function Main() {
  const srv = currentServer();
  const c = currentChannel();
  let content;
  if (S.route.kind === 'home' || (!srv && !c)) content = html`<${Friends} />`;
  else if (c?.kind === 'voice') content = html`<main class="chat"><${Stage} key=${c.id} c=${c} /></main>`;
  else if (c) content = html`<${ChatView} c=${c} />`;
  else content = html`<${NoChannels} srv=${srv} />`;

  const focusById = (id) => document.getElementById(id)?.focus();
  return html`<div class=${classes('shell', S.settings.compact && 'compact')}>
    <nav class="skip-links" aria-label="Skip links">
      ${c?.kind === 'text' && html`<button class="skip-link" onClick=${() => focusById('composer-input')}>Skip to the message box</button>`}
      ${c?.kind === 'text' && html`<button class="skip-link" onClick=${() => focusById('messages')}>Skip to messages</button>`}
      <button class="skip-link" onClick=${() => document.querySelector('.sidebar [aria-current="page"], .sidebar .channel-link')?.focus()}>Skip to channels</button>
    </nav>
    <${Banners} />
    <${UpdateBanner} />
    <div class="shell-columns">
      ${S.railOpen && html`<button class="drawer-scrim" aria-label="Close menu" onClick=${() => { S.railOpen = false; update(); }}></button>`}
      <div class=${classes('navigation', S.railOpen && 'open')}>
        <${Rail} />
        <${Sidebar} srv=${srv} />
      </div>
      ${content}
    </div>
    <${RingBanner} />
  </div>`;
}

/** What the opening animation says while the desktop app updates itself. */
function updateLine(u) {
  if (u.phase === 'checking') return 'Checking for updates…';
  if (u.phase === 'downloading') return `Downloading Pravda ${u.version}… ${Math.round((u.progress ?? 0) * 100)}%`;
  if (u.phase === 'installing') return `Installing Pravda ${u.version}…`;
  return null;
}

/** True while the desktop app is updating at launch and the reader is waiting. */
const updatingAtLaunch = () => {
  const u = S.update;
  return !!u && u.atLaunch && !u.deferred && ['checking', 'downloading', 'installing'].includes(u.phase);
};

function Splash({ leaving }) {
  const [line, setLine] = useState(0);
  const [patience, setPatience] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setLine((n) => (n + 1) % SPLASH_LINES.length), 900);
    const waited = setTimeout(() => setPatience(true), 8000);
    return () => { clearInterval(timer); clearTimeout(waited); };
  }, []);
  const u = updatingAtLaunch() ? S.update : null;
  const text = (u && updateLine(u)) ?? SPLASH_LINES[line];
  return html`<div class=${classes('splash', leaving && 'leaving')} role="status" aria-label="Pravda is starting">
    <${SplashArt} />
    <div class="splash-words-wrap">
      <div class="splash-words">
        <div class="splash-title">ПРАВДА</div>
        <div class="splash-line">${text}</div>
        ${u?.phase === 'downloading' && html`<div class="splash-progress" role="progressbar" aria-label="Update download"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round((u.progress ?? 0) * 100)}>
          <span style=${{ width: `${Math.round((u.progress ?? 0) * 100)}%` }}></span>
        </div>`}
        ${u?.phase === 'downloading' && patience && html`<button class="splash-skip" onClick=${() => desktop.deferUpdate()}>Continue without updating</button>`}
      </div>
    </div>
  </div>`;
}

function signedIn() {
  S.phase = 'connecting';
  update();
  connect(() => {
    // The session ended elsewhere: back to the sign-in page.
    location.reload();
  });
  requestNotificationPermission();
}

async function afterAuth(stage) {
  if (stage === 'enroll') {
    S.phase = 'enroll';
    update();
    return;
  }
  history.replaceState(null, '', location.pathname);
  await signedIn();
}

function applyAppearance() {
  const root = document.documentElement;
  const {
    theme, fontScale, reduceMotion, contrast, readableFont, alwaysTimestamps,
  } = S.settings;
  const dark = theme === 'night' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'night' : 'day';
  root.dataset.motion = reduceMotion ? 'reduced' : 'full';
  // 'system' follows the operating system's "increase contrast" setting.
  root.dataset.contrast = contrast === 'system' ? (matchMedia('(prefers-contrast: more)').matches ? 'high' : 'standard') : contrast;
  root.dataset.font = readableFont ? 'readable' : 'standard';
  root.dataset.times = alwaysTimestamps ? 'always' : 'hover';
  root.style.fontSize = `${fontScale}%`;
}

function App() {
  const [, redraw] = useState(0);
  // The opening animation runs 'showing' → 'leaving' (fading out over the
  // first real screen) → 'done'.
  const [splash, setSplash] = useState('showing');
  // Subscribe during the commit, not after paint: boot() goes on to fetch
  // state as soon as render() returns, and an update that lands before the
  // subscription would be lost, leaving the opening animation up for good.
  useLayoutEffect(() => {
    const unsubscribe = subscribe(() => redraw((n) => n + 1));
    redraw((n) => n + 1);
    return unsubscribe;
  }, []);
  useLayoutEffect(() => {
    applyAppearance();
    syncTitle();
  });
  // While the desktop app updates itself at launch, the opening animation
  // stays up and shows the progress.
  const ready = !['loading', 'connecting'].includes(S.phase) && !updatingAtLaunch();
  // Hold the opening animation for a moment so it never flashes past.
  useEffect(() => {
    if (!ready || splash === 'done') return undefined;
    const quick = S.settings.reduceMotion;
    const wait = splash === 'showing'
      ? (quick ? 0 : Math.max(0, SPLASH_MINIMUM_MS - (performance.now() - bootStarted)))
      : (quick ? 0 : SPLASH_FADE_MS);
    const timer = setTimeout(() => setSplash(splash === 'showing' ? 'leaving' : 'done'), wait);
    return () => clearTimeout(timer);
  }, [ready, splash]);

  const overlay = splash !== 'done' && html`<${Splash} leaving=${splash === 'leaving'} />`;
  let screen = null;
  if (!ready || splash === 'showing') {
    screen = null;
  } else if (S.phase === 'instance') {
    screen = html`<${InstancePicker} onChosen=${async (origin, path) => {
      await globalThis.pravdaDesktop.selectInstance(origin);
      // An invite link opens its invitation once the server is chosen.
      if (path) location.assign(path);
      else location.reload();
    }} />`;
  } else if (S.phase === 'auth') {
    screen = html`<${AuthScreen} onSignedIn=${afterAuth} />`;
  } else if (S.phase === 'unlock') {
    screen = html`<${UnlockScreen} onUnlocked=${() => afterAuth(S.stage)} onSignOut=${async () => {
      await api.post('/auth/logout').catch(() => {});
      await forgetIdentity();
      location.reload();
    }} />`;
  } else if (S.phase === 'enroll') {
    screen = html`<${EnrollScreen} onDone=${() => afterAuth('full')} />`;
  } else if (S.route.kind === 'invite') {
    screen = html`<${InviteLanding} onDone=${(joined) => navigate(joined ? `/channels/${joined.server_id}` : '/')} />`;
  } else {
    screen = html`<${Main} />`;
  }
  return html`${screen}<${CurrentModal} /><${CurrentPopover} /><${Toast} />${overlay}`;
}

function bindShortcuts() {
  addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inApp = S.phase === 'ready';
    if (e.key === 'Escape') {
      if (S.popover) closePopover();
      else if (S.modal) closeModal();
      else if (S.panel) {
        S.panel = null;
        update();
      } else if (inApp && !e.defaultPrevented) {
        markHereRead(e.shiftKey);
      }
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyK' && inApp) {
      e.preventDefault();
      if (S.modal?.kind === 'switcher') closeModal();
      else openModal('switcher');
      return;
    }
    if (mod && (e.code === 'Slash' || e.key === '/')) {
      e.preventDefault();
      openModal('shortcuts');
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyF' && inApp && currentChannel()?.kind === 'text') {
      e.preventDefault();
      S.panel = 'search';
      update();
      return;
    }
    if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && inApp && !S.modal) {
      e.preventDefault();
      stepChannel(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      if (e.code === 'KeyM') {
        e.preventDefault();
        shortcut('mute');
      } else if (e.code === 'KeyD') {
        e.preventDefault();
        shortcut('deafen');
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'Comma') {
      e.preventDefault();
      openModal('userSettings');
    }
  });
  // The desktop app relays its global shortcuts, which also fire while
  // Pravda is focused; shortcut() makes sure one press toggles once.
  globalThis.pravdaDesktop?.onShortcut?.(shortcut);
}

const lastShortcut = new Map();
function shortcut(name) {
  const now = performance.now();
  if (now - (lastShortcut.get(name) ?? -Infinity) < 400) return;
  lastShortcut.set(name, now);
  if (name === 'mute') toggleMute();
  if (name === 'deafen') toggleDeafen();
}

async function boot() {
  startRouter();
  applyAppearance();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);
  matchMedia('(prefers-contrast: more)').addEventListener('change', update);
  if (desktop?.onUpdateState) {
    const announceUpdated = (state) => {
      if (state?.updatedTo && !S.updateAnnounced) {
        S.updateAnnounced = true;
        toast(`Updated to Pravda ${state.updatedTo}.`);
      }
    };
    desktop.onUpdateState((state) => {
      S.update = state;
      announceUpdated(state);
      update();
    });
    S.update = await desktop.getUpdateState();
    announceUpdated(S.update);
  }
  render(html`<${App} />`, document.getElementById('app'));
  bindShortcuts();
  bindPushToTalk();
  addEventListener('beforeunload', disconnect);
  addEventListener('visibilitychange', update);

  if (isDesktop()) {
    const current = await globalThis.pravdaDesktop.currentInstance();
    if (!current) {
      S.phase = 'instance';
      update();
      return;
    }
    await configure(current);
  }
  S.instance = await api.get('/instance').catch(() => null);
  if (!S.instance && isDesktop()) {
    S.phase = 'instance';
    update();
    return;
  }
  try {
    const me = await api.get('/users/@me');
    S.me = me.user;
    S.stage = me.stage;
    S.users.set(me.user.id, me.user);
    if (!(await restoreIdentity(me.user.id))) {
      S.phase = 'unlock';
    } else if (me.stage === 'enroll') {
      S.phase = 'enroll';
    } else {
      await signedIn();
      return;
    }
  } catch {
    S.phase = 'auth';
  }
  update();
}

boot();
