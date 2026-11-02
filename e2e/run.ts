/// <reference lib="dom" />
/// <reference lib="deno.ns" />
// End-to-end test: real browsers with fake cameras and microphones, driving
// the real interface against a real server.
//
//   deno run -A e2e/run.ts [path-to-pravda-binary] [screenshot-dir]
//
// Beyond features, it checks the promises Pravda makes: the server's database
// never contains what people wrote, every call stream passes through the
// frame encryptor, and nothing on screen overflows or overlaps.

import puppeteer, { type Browser, type Page } from "npm:puppeteer-core@24";

const binary = Deno.args[0] ?? "./pravda";
const shots = Deno.args[1] ?? await Deno.makeTempDir({ prefix: "pravda-shots-" });
const chromium = Deno.env.get("CHROMIUM") ?? "/usr/bin/chromium";
const port = 18347;
const mediaPort = 18348;
const base = `http://127.0.0.1:${port}`;
const PASSWORD = { vera: "worker and collective farm", pyotr: "constructivism forever" };
const SECRET_PHRASES = ["Checking in from the night shift", "Night Owls", "the launch plan is secret", "An edited message", "A private word"];

let failures = 0;
const results: string[] = [];
let onFailure: (name: string) => Promise<void> = async () => {};

function record(ok: boolean, name: string, detail?: unknown) {
  const line = ok ? `  ok    ${name}` : `  FAIL  ${name}: ${detail}`;
  if (!ok) failures += 1;
  results.push(line);
  console.log(line);
}

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    record(true, name);
  } catch (err) {
    record(false, name, err instanceof Error ? err.message : err);
    await onFailure(name).catch(() => {});
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T>, timeout = 15000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (err) {
      last = err;
    }
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

// RFC 6238, as an authenticator app computes it.
function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/\s|=/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out) as Uint8Array<ArrayBuffer>;
}

async function totp(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter.buffer));
  const o = mac[mac.length - 1] & 15;
  const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** Waits for the next authenticator time step, so a fresh code is valid. */
const nextTotpWindow = () => sleep(30000 - (Date.now() % 30000) + 300);

const PROBE = `
  window.__pcs = [];
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    window.__pcs.push(pc);
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  Object.assign(window.RTCPeerConnection, Native);
  window.__mediaStats = async () => {
    const out = { audioIn: 0, videoIn: 0, framesDecoded: 0, audioOut: 0, videoOut: 0 };
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') out.audioIn += s.bytesReceived;
        if (s.type === 'inbound-rtp' && s.kind === 'video') { out.videoIn += s.bytesReceived; out.framesDecoded += s.framesDecoded ?? 0; }
        if (s.type === 'outbound-rtp' && s.kind === 'audio') out.audioOut += s.bytesSent;
        if (s.type === 'outbound-rtp' && s.kind === 'video') out.videoOut += s.bytesSent;
      });
    }
    return out;
  };
  // Lists every live sender and receiver and whether a frame transform is attached.
  window.__transforms = () => {
    const out = [];
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue;
      for (const t of pc.getTransceivers()) {
        if (t.currentDirection === 'stopped' || t.currentDirection === 'inactive') continue;
        const legacy = !('RTCRtpScriptTransform' in window);
        if (t.direction.includes('send')) out.push({ side: 'send', kind: t.sender.track?.kind ?? t.receiver.track.kind, ok: legacy || !!t.sender.transform });
        if (t.receiver.track && t.currentDirection && t.currentDirection.includes('recv')) out.push({ side: 'recv', kind: t.receiver.track.kind, ok: legacy || !!t.receiver.transform });
      }
    }
    return out;
  };
`;

interface Client {
  browser: Browser;
  page: Page;
  errors: string[];
  secret?: string;
}

async function launch(name: string): Promise<Client> {
  const browser = await puppeteer.launch({
    executablePath: chromium,
    headless: true,
    userDataDir: await Deno.makeTempDir({ prefix: `pravda-${name}-` }),
    args: [
      "--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--auto-accept-this-tab-capture", "--auto-select-desktop-capture-source=Entire screen",
      "--autoplay-policy=no-user-gesture-required", "--force-color-profile=srgb", "--window-size=1440,900",
    ],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(PROBE);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${name}: ${(e as Error).message}`));
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" && !/Failed to load resource|401|409|ERR_ABORTED/.test(text)) errors.push(`${name}: ${text}`);
  });
  return { browser, page, errors };
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${shots}/${name}.png` as `${string}.png` });

async function text(page: Page, selector: string) {
  return await page.$eval(selector, (el) => el.textContent ?? "").catch(() => "");
}

async function clickText(page: Page, selector: string, label: string) {
  const handle = await until(`button "${label}"`, async () => {
    for (const h of await page.$$(selector)) {
      // Visible text only: screen-reader-only words do not count.
      const t = await h.evaluate((el) => {
        const copy = el.cloneNode(true) as Element;
        copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
        return (copy.textContent ?? "").trim().replace(/\s+/g, " ");
      });
      if (t === label) return h;
    }
    return null;
  });
  await handle!.click();
}

async function setInput(page: Page, selector: string, value: string) {
  const el = await until(`input ${selector}`, () => page.$(selector));
  await el!.click({ count: 3 });
  await page.keyboard.press("Backspace");
  await el!.type(value);
}

async function postMessage(page: Page, message: string) {
  await page.waitForSelector(".composer textarea");
  await page.type(".composer textarea", message);
  await page.keyboard.press("Enter");
}

// innerText applies CSS text-transform, so compare without regard to case.
const seesText = (page: Page, needle: string, timeout = 15000) =>
  until(`text "${needle}"`, () => page.evaluate((n) => document.body.innerText.toLowerCase().includes(n.toLowerCase()), needle), timeout);

// The opening animation fades out over the first screen; wait for it to go.
const splashGone = (page: Page) => until("the opening animation to finish", () => page.evaluate(() => !document.querySelector(".splash")), 10000);

const stats = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __mediaStats: () => Promise<Record<string, number>> }).__mediaStats());

async function growing(page: Page, key: string, min = 1) {
  const a = await stats(page);
  await sleep(1500);
  const b = await stats(page);
  if (!(b[key] > a[key] && b[key] >= min)) throw new Error(`${key} did not grow: ${a[key]} -> ${b[key]}`);
}

/** Registers through the real form, including recovery key and authenticator. */
async function register(c: Client, username: string, display: string, password: string) {
  await setInput(c.page, 'input[autocomplete="username"]', username);
  await setInput(c.page, 'input[autocomplete="nickname"]', display);
  const pw = await c.page.$$('input[autocomplete="new-password"]');
  await pw[0].type(password);
  await pw[1].type(password);
  await clickText(c.page, "button", "Create account");
  await seesText(c.page, "Your recovery key", 30000);
  await c.page.click(".secret-sheet .check input");
  await clickText(c.page, "button", "Continue");
  const secret = await until("authenticator secret", () => c.page.$eval(".secret-inline", (el) => el.textContent ?? ""));
  c.secret = secret.replace(/\s/g, "");
  await setInput(c.page, ".code-input", await totp(c.secret));
  await clickText(c.page, "button", "Confirm");
  await seesText(c.page, "recovery codes");
  await c.page.click(".secret-sheet .check input");
  await clickText(c.page, "button", "Continue");
}

/**
 * Layout audit: no visible text box may overflow its own box, and no two
 * children of a toolbar-like container may overlap.
 */
async function layoutProblems(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const problems: string[] = [];
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const describe = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    const scrollers = "svg, .message-scroll, .settings-page, .settings-nav, .modal-body, .panel-body, .members, .sidebar-scroll, .friends-body, .emoji-picker, .pick-list, .suggestions, pre, textarea, input, select, .cinema-screen, .rail, .tabs, .auth-panel";
    for (const el of document.querySelectorAll("body *")) {
      if (!visible(el) || el.closest(scrollers)) continue;
      const cs = getComputedStyle(el);
      if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && el.scrollWidth > el.clientWidth + 2 && el.textContent?.trim()) {
        problems.push(`clipped: ${describe(el)} (${el.scrollWidth} > ${el.clientWidth})`);
      }
    }
    const containers = ".masthead, .masthead-tools, .user-bar, .call-actions, .stage-controls, .cinema-bar, .message-head, .channel-row, .sidebar-head, .panel-head, .modal-head, .composer, .card-actions, .row-buttons, .auth-brand, .settings-nav, .find-button, .unread-banner, .switcher-item, .shortcut-row, .menu-item";
    for (const box of document.querySelectorAll(containers)) {
      if (!visible(box)) continue;
      const kids = [...box.children].filter((k) => visible(k) && getComputedStyle(k).position !== "absolute");
      for (let i = 0; i < kids.length; i += 1) {
        for (let j = i + 1; j < kids.length; j += 1) {
          const a = kids[i].getBoundingClientRect();
          const b = kids[j].getBoundingClientRect();
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 1 && overlapY > 1) problems.push(`overlap in ${describe(box)}: ${describe(kids[i])} / ${describe(kids[j])}`);
        }
      }
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    return problems.slice(0, 12);
  });
}

async function auditAt(page: Page, label: string, width: number, height: number) {
  await page.setViewport({ width, height });
  await sleep(400);
  const problems = await layoutProblems(page);
  await shot(page, `layout-${label}`);
  if (problems.length) throw new Error(`${label}: ${problems.join(" | ")}`);
}

async function sqlite(path: string, query: string): Promise<string> {
  const out = await new Deno.Command("sqlite3", { args: ["-readonly", path, query], stdout: "piped", stderr: "piped" }).output();
  return new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
}

// ---- server ----
const dataDir = await Deno.makeTempDir({ prefix: "pravda-e2e-" });
const server = new Deno.Command(binary, {
  args: ["--listen", `127.0.0.1:${port}`, "--data", dataDir, "--media-udp", String(mediaPort), "--media-tcp", "0", "--name", "Test Pravda"],
  env: { PRAVDA_WEB_DIR: Deno.env.get("PRAVDA_WEB_DIR") ?? "" },
  stdout: "piped",
  stderr: "piped",
}).spawn();
const serverLog: string[] = [];
(async () => {
  for await (const chunk of server.stderr.pipeThrough(new TextDecoderStream())) serverLog.push(chunk);
})();
await until("server", async () => (await fetch(`${base}/healthz`)).ok);

const vera = await launch("vera");
const pyotr = await launch("pyotr");
let veraTwo: Client | null = null;
let exitCode = 1;
onFailure = async (name) => {
  const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
  await shot(vera.page, `fail-${slug}-vera`);
  await shot(pyotr.page, `fail-${slug}-pyotr`);
  if (veraTwo) {
    await shot(veraTwo.page, `fail-${slug}-vera-laptop`);
    console.log(`        laptop: ${veraTwo.page.url()} ${veraTwo.errors.slice(0, 3).join(" | ")}`);
  }
};

try {
  console.log("\nFirst run, keys and authenticator");
  await check("the opening animation plays, then the sign-in poster", async () => {
    await vera.page.goto(base);
    await until("splash", () => vera.page.$(".splash"), 3000);
    await sleep(450);
    await shot(vera.page, "00-splash");
    await seesText(vera.page, "first account created runs it");
    await splashGone(vera.page);
    await until("fonts", () => vera.page.evaluate(() => document.fonts.ready.then(() => true)));
    await shot(vera.page, "01-sign-in");
  });
  await check("registration creates keys, a recovery key and an authenticator", async () => {
    await register(vera, "vera", "Vera Mukhina", PASSWORD.vera);
    await seesText(vera.page, "Direct messages", 20000);
  });
  await check("the server holds keys only in sealed form", async () => {
    const row = await sqlite(`${dataDir}/pravda.db`, "SELECT key_bundle, length(auth_hash) > 50, totp_enabled FROM users WHERE username = 'vera';");
    if (!row.includes('"ct"') || !row.trim().endsWith("|1|1")) throw new Error(`unexpected user row: ${row.slice(0, 160)}`);
    if (row.includes(PASSWORD.vera)) throw new Error("the password reached the server");
  });

  console.log("\nAn encrypted server");
  let invite = "";
  await check("a server is created with its names encrypted", async () => {
    await vera.page.click(".rail-add");
    await setInput(vera.page, ".split-forms form input", "Night Owls");
    await clickText(vera.page, ".split-forms button", "Create server");
    await seesText(vera.page, "general");
    await until("URL", () => vera.page.evaluate(() => /channels\/\d+\/\d+/.test(location.pathname)));
  });
  await check("messages post, render and never become markup", async () => {
    await postMessage(vera.page, "**Greetings** everyone, the launch plan is secret");
    await until("bold", () => vera.page.evaluate(() => document.querySelector(".message-text strong")?.textContent === "Greetings"));
    await postMessage(vera.page, '<img src=x onerror="window.__pwned=1"> [x](javascript:alert(1))');
    await seesText(vera.page, "onerror");
    const safe = await vera.page.evaluate(() => !(globalThis as unknown as { __pwned?: number }).__pwned && !document.querySelector('.message-text img, .message-text a[href^="javascript"]'));
    if (!safe) throw new Error("markup escaped into the page");
  });
  await check("an invite link carries the key in its fragment", async () => {
    await vera.page.click(".sidebar-head");
    await clickText(vera.page, ".menu-item", "Invite people");
    invite = await until("invite URL", () => vera.page.$eval(".copy-row input", (el) => (el as HTMLInputElement).value));
    if (!/\/invite\/\w+#[\w-]{40,}$/.test(invite)) throw new Error(`no key fragment in ${invite}`);
    await vera.page.keyboard.press("Escape");
  });

  console.log("\nA new member joins and receives the keys");
  await check("the invite preview decrypts the server's name with the link's key", async () => {
    await pyotr.page.goto(invite);
    await seesText(pyotr.page, "Night Owls");
    await shot(pyotr.page, "02-invited");
  });
  await check("the new member registers through the link", async () => {
    await register(pyotr, "pyotr", "Pyotr", PASSWORD.pyotr);
    await until("landing", () => pyotr.page.$(".invite-landing, .rail"), 20000);
    if (await pyotr.page.$(".invite-landing")) await clickText(pyotr.page, ".invite-actions button", "Accept invite");
    await until("the server", () => pyotr.page.$(".rail-item.active .emblem"));
    await seesText(pyotr.page, "Night Owls");
  });
  await check("history is readable once a holder shares the key", async () => {
    await seesText(pyotr.page, "the launch plan is secret", 25000);
  });
  await check("messages flow both ways, encrypted", async () => {
    await postMessage(pyotr.page, "Checking in from the night shift");
    await seesText(vera.page, "Checking in from the night shift");
    await postMessage(vera.page, "Welcome aboard");
    await seesText(pyotr.page, "Welcome aboard");
  });
  await check("typing indicators appear", async () => {
    await pyotr.page.type(".composer textarea", "thinking");
    await seesText(vera.page, "is typing");
    await pyotr.page.$eval(".composer textarea", (el) => { (el as HTMLTextAreaElement).value = ""; });
  });
  await check("mentions are declared and highlighted", async () => {
    await vera.page.type(".composer textarea", "Hello @pyo");
    await until("suggestion", () => vera.page.$(".suggestion"));
    await vera.page.keyboard.press("Enter");
    await vera.page.type(".composer textarea", "good to see you");
    await vera.page.keyboard.press("Enter");
    await until("highlight", () => pyotr.page.$(".message.mentioned"));
  });
  await check("encrypted reactions travel", async () => {
    const msg = await until("a message", async () => (await pyotr.page.$$(".message:not(.system)")).at(-1));
    await msg!.hover();
    await (await msg!.$('.message-tools button[aria-label="React"]'))!.click();
    await (await until("emoji", () => pyotr.page.$(".emoji")))!.click();
    await until("reaction", () => vera.page.$(".reaction"));
  });
  await check("editing re-encrypts for everyone", async () => {
    await vera.page.focus(".composer textarea");
    await vera.page.keyboard.press("ArrowUp");
    await until("edit box", () => vera.page.$(".edit-box textarea"));
    await vera.page.keyboard.down("Control");
    await vera.page.keyboard.press("KeyA");
    await vera.page.keyboard.up("Control");
    await vera.page.keyboard.type("An edited message");
    await vera.page.keyboard.press("Enter");
    await seesText(pyotr.page, "An edited message");
  });
  await check("files are encrypted before upload and decrypted to display", async () => {
    const path = `${dataDir}/poster.png`;
    await Deno.copyFile("web/public/img/icon-192.png", path);
    await (await vera.page.$('.composer input[type="file"]'))!.uploadFile(path);
    await until("upload", () => vera.page.evaluate(() => document.querySelector(".upload-size")?.textContent?.includes("KB")));
    await vera.page.focus(".composer textarea");
    await vera.page.keyboard.press("Enter");
    await until("decrypted image", () => pyotr.page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>(".attachment-image img");
      return img?.complete && img.naturalWidth === 192;
    }), 20000);
    const stored = await sqlite(`${dataDir}/pravda.db`, "SELECT filename, mime FROM attachments WHERE kind = 'message';");
    if (!stored.includes("encrypted|application/octet-stream") || stored.includes("poster.png")) throw new Error(`attachment metadata leaked: ${stored}`);
  });
  await shot(vera.page, "03-chat-day");
  await vera.page.evaluate(() => localStorage.setItem("pravda.settings", JSON.stringify({ theme: "night" })));
  await vera.page.reload();
  await check("a reload restores the session and the keys", async () => {
    await seesText(vera.page, "An edited message", 20000);
    await splashGone(vera.page);
    await shot(vera.page, "04-chat-night");
  });

  console.log("\nEncrypted calls");
  await check("both members join the voice channel", async () => {
    await clickText(vera.page, ".channel-link", "Lounge");
    await until("connected", async () => (await text(vera.page, ".call-state")) === "Voice connected");
    await clickText(pyotr.page, ".channel-link", "Lounge");
    await until("connected", async () => (await text(pyotr.page, ".call-state")) === "Voice connected");
  });
  await check("audio decodes, so both ends share the call key", async () => {
    await growing(pyotr.page, "audioIn", 500);
    await growing(vera.page, "audioIn", 500);
  });
  await check("speaking is detected", async () => {
    await until("speaking outline", () => pyotr.page.$(".voice-person.speaking, .tile.speaking"), 20000);
    await shot(pyotr.page, "05-call-voice");
  });
  await check("encrypted camera video decodes on the other side", async () => {
    await vera.page.click('.call-actions button[aria-label="Turn camera on"]');
    await until("frames", async () => (await stats(pyotr.page)).framesDecoded > 10, 20000);
    await until("video tile", () => pyotr.page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>(".tile video");
      return !!v && v.videoWidth > 0;
    }));
    await sleep(600);
    await shot(pyotr.page, "05-call-camera");
  });
  await check("every sender and receiver runs through the frame encryptor", async () => {
    for (const [who, c] of [["vera", vera], ["pyotr", pyotr]] as const) {
      const list = await c.page.evaluate(() => (globalThis as unknown as { __transforms: () => { side: string; kind: string; ok: boolean }[] }).__transforms());
      if (list.length < 3) throw new Error(`${who}: expected live streams, found ${JSON.stringify(list)}`);
      const bare = list.filter((t) => !t.ok);
      if (bare.length) throw new Error(`${who}: unencrypted ${JSON.stringify(bare)}`);
    }
  });
  await check("the camera turns off cleanly", async () => {
    await vera.page.click('.call-actions button[aria-label="Turn camera off"]');
    await until("tile to revert", () => pyotr.page.evaluate(() => !document.querySelector(".tile video")));
  });
  await check("a screen share is offered, watched and decoded", async () => {
    await vera.page.click('.call-actions button[aria-label="Share your screen"]');
    await seesText(pyotr.page, "is broadcasting");
    const before = (await stats(pyotr.page)).framesDecoded;
    await clickText(pyotr.page, ".watch-prompt button", "Watch");
    await until("screen frames", async () => (await stats(pyotr.page)).framesDecoded > before + 10, 20000);
    await vera.page.click('.call-actions button[aria-label="Stop sharing"]');
    await until("screen tile gone", () => pyotr.page.evaluate(() => !document.querySelector(".screen-tile")));
  });
  await check("a film from disk streams to the call without being uploaded", async () => {
    const film = `${dataDir}/film.webm`;
    const made = await new Deno.Command("ffmpeg", {
      args: ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=330", "-t", "30",
        "-c:v", "libvpx", "-b:v", "800k", "-c:a", "libopus", film],
    }).output();
    if (!made.success) throw new Error("could not make a test film");
    await vera.page.click('.stage-controls button[aria-label="Watch together"]');
    await until("watch modal", () => vera.page.$('.modal input[type="file"]'));
    await (await vera.page.$('.modal input[type="file"]'))!.uploadFile(film);
    await seesText(pyotr.page, "is broadcasting", 20000);
    const before = (await stats(pyotr.page)).framesDecoded;
    await clickText(pyotr.page, ".watch-prompt button", "Watch");
    await until("film frames", async () => (await stats(pyotr.page)).framesDecoded > before + 15, 20000);
    await sleep(500);
    await shot(pyotr.page, "06-cinema-film");
    await vera.page.click('.stage-controls button[aria-label="Stop the video"]');
    await until("film gone", () => pyotr.page.evaluate(() => !document.querySelector(".screen-tile")));
  });
  await check("watching together syncs a YouTube choice to everyone", async () => {
    await vera.page.click('.stage-controls button[aria-label="Watch together"]');
    await setInput(vera.page, '.modal input[placeholder^="https://www.youtube.com"]', "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await clickText(vera.page, ".modal button", "Start");
    await until("cinema on both", async () => (await vera.page.$(".cinema")) && (await pyotr.page.$(".cinema")));
    await seesText(pyotr.page, "Chosen by Vera Mukhina");
    await seesText(pyotr.page, "www.youtube-nocookie.com");
    await shot(pyotr.page, "07-cinema-consent");
    await pyotr.page.click('.cinema-bar button[aria-label="Pause for everyone"]');
    await until("paused for vera", () => vera.page.$('.cinema-bar button[aria-label="Play for everyone"]'));
    await vera.page.click('.cinema-bar button[aria-label="Stop watching for everyone"]');
    await until("cinema gone", async () => !(await pyotr.page.$(".cinema")));
  });
  await check("leaving the call updates everyone", async () => {
    await vera.page.click('.call-actions button[aria-label="Leave call"]');
    await until("roster", () => pyotr.page.evaluate(() => document.querySelectorAll(".voice-person").length === 1));
    await pyotr.page.click('.call-actions button[aria-label="Leave call"]');
  });

  console.log("\nDirect messages");
  await check("a DM starts, encrypts and is read by the other side", async () => {
    await pyotr.page.goto(base);
    await setInput(pyotr.page, ".add-friend input", "vera");
    await clickText(pyotr.page, ".add-friend button", "Send request");
    await vera.page.goto(base);
    await clickText(vera.page, ".tab", "Requests 1");
    await (await until("accept", () => vera.page.$('.friend-row button[aria-label="Accept"]')))!.click();
    await clickText(vera.page, ".tab", "All friends");
    await (await until("message", () => vera.page.$('.friend-row button[aria-label="Message"]')))!.click();
    await until("DM composer", () => vera.page.$(".composer textarea"));
    await postMessage(vera.page, "A private word");
    const row = await until("the DM in the sidebar", async () => {
      for (const h of await pyotr.page.$$(".dm-row .channel-link")) {
        if ((await h.evaluate((el) => el.textContent ?? "")).includes("Vera")) return h;
      }
      return null;
    });
    await row!.click();
    await seesText(pyotr.page, "A private word", 20000);
  });
  await check("disappearing messages can be switched on", async () => {
    await vera.page.click('.masthead-tools button[aria-label="Disappearing messages"]');
    await until("timer dialog", () => vera.page.$(".modal select"));
    await vera.page.select(".modal select", "300");
    await clickText(vera.page, ".modal-foot button", "Save");
    await seesText(pyotr.page, "disappear after 5 minutes");
  });
  await check("a DM call rings the other person", async () => {
    await vera.page.click('.masthead-tools button[aria-label="Start an encrypted call"]');
    await until("ring", () => pyotr.page.$(".ring"));
    await shot(pyotr.page, "08-ring");
    await clickText(pyotr.page, ".ring button", "Answer");
    await until("connected", async () => (await text(pyotr.page, ".call-state")) === "Voice connected");
    await growing(pyotr.page, "audioIn", 200);
    await vera.page.click('.stage-controls button[aria-label="Disconnect"]');
  });

  console.log("\nQuality of life and accessibility");
  type Key = Parameters<Page["keyboard"]["press"]>[0];
  const chord = async (page: Page, keys: Key[]) => {
    for (const k of keys.slice(0, -1)) await page.keyboard.down(k);
    await page.keyboard.press(keys[keys.length - 1]);
    for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k);
  };
  await check("the quick switcher jumps to a channel by name", async () => {
    await splashGone(vera.page);
    await chord(vera.page, ["Control", "k"]);
    await until("switcher", () => vera.page.$(".switcher-input"));
    await vera.page.type(".switcher-input", "gen");
    await until("a result", () => vera.page.$(".switcher-item.active"));
    await shot(vera.page, "09-switcher");
    await vera.page.keyboard.press("Enter");
    await until("#general open", () => vera.page.evaluate(() => /^\/channels\/\d+\/\d+$/.test(location.pathname) && !!document.querySelector(".masthead h1")?.textContent?.includes("general")));
  });
  await check("the shortcuts sheet opens with Ctrl+/", async () => {
    await chord(vera.page, ["Control", "/"]);
    await until("shortcuts", () => vera.page.$(".shortcut-list"));
    const problems = await layoutProblems(vera.page);
    if (problems.length) throw new Error(problems.join(" | "));
    await vera.page.keyboard.press("Escape");
    await until("closed", async () => !(await vera.page.$(".shortcut-list")));
  });
  await check("a channel can be muted and unmuted from its menu", async () => {
    const link = await until("channel link", () => vera.page.$(".channel-row .channel-link"));
    await link!.click({ button: "right" });
    await clickText(vera.page, ".menu-item", "Nothing (muted)");
    await until("muted row", () => vera.page.$(".channel-row.muted"));
    const saved = await vera.page.evaluate(() => JSON.parse(localStorage.getItem("pravda.settings") ?? "{}").notifyLevels ?? {});
    if (!Object.values(saved).includes("none")) throw new Error(`level not saved: ${JSON.stringify(saved)}`);
    await (await vera.page.$(".channel-row .channel-link"))!.click({ button: "right" });
    await clickText(vera.page, ".menu-item", "Same as the server");
    await until("unmuted", async () => !(await vera.page.$(".channel-row.muted")));
  });
  await check("Alt+Shift+Down jumps to the conversation with something new, marked by a rule", async () => {
    await postMessage(pyotr.page, "Are you still there?");
    await until("the DM badge on the rail", () => vera.page.$(".rail-badge"));
    await chord(vera.page, ["Alt", "Shift", "ArrowDown"]);
    await until("the DM opens", () => vera.page.evaluate(() => location.pathname.startsWith("/channels/@me/")));
    await until("the new-messages rule", () => vera.page.$(".new-rule"));
    await seesText(vera.page, "Are you still there?");
  });
  await check("messages can be walked through with the arrow keys", async () => {
    const last = await until("last message", () => vera.page.$('article.message[tabindex="0"]'));
    await last!.focus();
    const before = await vera.page.evaluate(() => document.activeElement?.id);
    await vera.page.keyboard.press("ArrowUp");
    const after = await vera.page.evaluate(() => document.activeElement?.id);
    if (!after || after === before) throw new Error(`focus did not move (${before} -> ${after})`);
    const toolbar = await vera.page.evaluate(() => getComputedStyle(document.activeElement!.querySelector(".message-tools") ?? document.body).display);
    if (toolbar === "none") throw new Error("the focused message's actions are hidden");
    await vera.page.keyboard.press("Escape");
    await until("back in the message box", () => vera.page.evaluate(() => document.activeElement?.id === "composer-input"));
  });
  await check("accessibility settings: high contrast, readable font and 150% text keep the layout whole", async () => {
    await vera.page.click('.user-bar button[aria-label="Settings"]');
    await clickText(vera.page, ".settings-tab", "Accessibility");
    await vera.page.evaluate(() => {
      [...document.querySelectorAll<HTMLButtonElement>(".choice")].find((b) => b.querySelector("strong")?.textContent === "High")?.click();
      const readable = [...document.querySelectorAll(".toggle")].find((t) => t.querySelector(".toggle-label")?.textContent === "Readable font");
      readable?.querySelector("input")?.click();
      const size = document.querySelector<HTMLInputElement>('input[type="range"][max="150"]')!;
      size.value = "150";
      size.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await until("applied", () => vera.page.evaluate(() => document.documentElement.dataset.contrast === "high" && document.documentElement.dataset.font === "readable"));
    const font = await vera.page.evaluate(() => getComputedStyle(document.body).fontFamily);
    if (!font.includes("Atkinson")) throw new Error(`body font is ${font}`);
    await sleep(400);
    await shot(vera.page, "settings-accessibility-high");
    const inSettings = await layoutProblems(vera.page);
    await vera.page.keyboard.press("Escape");
    await sleep(400);
    const inApp = await layoutProblems(vera.page);
    await shot(vera.page, "10-high-contrast-readable");
    const problems = [...inSettings, ...inApp];
    if (problems.length) throw new Error(problems.join(" | "));
  });
  await vera.page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("pravda.settings") ?? "{}");
    localStorage.setItem("pravda.settings", JSON.stringify({ ...s, contrast: "system", readableFont: false, fontScale: 100 }));
  });
  await vera.page.reload();
  await splashGone(vera.page);

  await check("the database contains none of what anyone wrote", async () => {
    await sleep(500);
    const dump = await sqlite(`${dataDir}/pravda.db`, ".dump");
    const wal = await Deno.readFile(`${dataDir}/pravda.db-wal`).catch(() => new Uint8Array());
    const everything = dump + new TextDecoder("latin1").decode(wal);
    for (const phrase of SECRET_PHRASES) {
      if (everything.includes(phrase)) throw new Error(`plaintext "${phrase}" is stored on the server`);
    }
  });

  console.log("\nA second device");
  await check("signing in elsewhere needs the password and a fresh code, then decrypts history", async () => {
    veraTwo = await launch("vera-laptop");
    await veraTwo.page.goto(base);
    await setInput(veraTwo.page, 'input[autocomplete="username"]', "vera");
    await setInput(veraTwo.page, 'input[autocomplete="current-password"]', PASSWORD.vera);
    await clickText(veraTwo.page, "button", "Sign in");
    await until("code step", () => veraTwo!.page.$(".code-input"), 30000);
    await nextTotpWindow();
    await setInput(veraTwo.page, ".code-input", await totp(vera.secret!));
    await clickText(veraTwo.page, "button", "Verify");
    await seesText(veraTwo.page, "Direct messages", 20000);
    const row = await until("the DM", async () => {
      for (const h of await veraTwo!.page.$$(".dm-row .channel-link")) {
        if ((await h.evaluate((el) => el.textContent ?? "")).includes("Pyotr")) return h;
      }
      return null;
    });
    await row!.click();
    await seesText(veraTwo.page, "A private word", 20000);
  });

  console.log("\nLayout");
  await check("the server reopens with its history", async () => {
    await vera.page.goto(`${base}/`);
    const tile = await until("the server in the rail", () => vera.page.$(".rail-item:not(:first-child) .rail-tile"), 20000);
    await tile!.click();
    await seesText(vera.page, "An edited message", 20000);
  });
  await check("nothing overflows or overlaps on a desktop", () => auditAt(vera.page, "desktop", 1440, 900));
  await check("nothing overflows or overlaps on a laptop", () => auditAt(vera.page, "laptop", 1024, 700));
  await check("nothing overflows or overlaps on a phone", () => auditAt(vera.page, "phone", 390, 780));
  await vera.page.setViewport({ width: 1440, height: 900 });
  await check("settings pages lay out cleanly", async () => {
    await vera.page.click('.user-bar button[aria-label="Settings"]');
    for (const page of ["Profile", "Security", "Voice and video", "Appearance", "Accessibility", "Notifications"]) {
      await clickText(vera.page, ".settings-tab", page);
      await sleep(350);
      const problems = await layoutProblems(vera.page);
      await shot(vera.page, `settings-${page.toLowerCase().replace(/\W+/g, "-")}`);
      if (problems.length) throw new Error(`${page}: ${problems.join(" | ")}`);
    }
    await vera.page.keyboard.press("Escape");
  });

  const laptop = veraTwo as Client | null;
  const pageErrors = [...vera.errors, ...pyotr.errors, ...(laptop?.errors ?? [])];
  await check("no uncaught errors in any browser", () => {
    if (pageErrors.length > 0) throw new Error(pageErrors.slice(0, 6).join(" | "));
    return Promise.resolve();
  });
  exitCode = failures === 0 ? 0 : 1;
} finally {
  for (const c of [vera, pyotr, veraTwo]) await c?.browser.close().catch(() => {});
  try {
    server.kill("SIGTERM");
  } catch {
    console.log("\nThe server had already exited.");
  }
  const status = await server.status;
  const log = serverLog.join("");
  const errors = log.split("\n").filter((l) => /level=ERROR|panic|DATA RACE/.test(l));
  if (errors.length || (!status.success && status.signal !== "SIGTERM" && status.code !== 0)) {
    console.log(`\nServer problems:\n${errors.slice(0, 10).join("\n")}\n${log.slice(-3000)}`);
    exitCode = 1;
  }
  console.log(`\n${results.length - failures}/${results.length} passed. Screenshots in ${shots}`);
  await Deno.remove(dataDir, { recursive: true }).catch(() => {});
}
Deno.exit(exitCode);
