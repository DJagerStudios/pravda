// Drives the desktop app through Chromium's debugging protocol: add a server
// with a self-signed certificate, register with an authenticator, check the
// token is kept encrypted, survive a reload, switch servers, host a server,
// and show the certificate trust prompt. Run it through desktop-nested.sh so
// it happens in a private, invisible KWin session.
//
//   deno run -A --no-lock e2e/desktop.ts <electron> <pravda-binary> <shots-dir>

/// <reference lib="dom" />
/// <reference lib="deno.ns" />
import puppeteer, { type Browser, type Page } from "npm:puppeteer-core@24";

const [electron, binary, shots] = Deno.args;
if (!electron || !binary || !shots) {
  console.error("usage: desktop.ts <electron> <pravda-binary> <shots-dir>");
  Deno.exit(2);
}
await Deno.mkdir(shots, { recursive: true });
const repo = new URL("..", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T> | T, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last as T;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

// ---- TOTP, as the authenticator app would compute it ----
function base32(s: string): Uint8Array<ArrayBuffer> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const out = new Uint8Array(new ArrayBuffer(Math.floor(bits.length / 8)));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}
async function totp(secret: string): Promise<string> {
  const counter = Math.floor(Date.now() / 30000);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", base32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = mac[19] & 15;
  const n = ((mac[o] & 127) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1e6).padStart(6, "0");
}

// ---- servers ----
async function startServer(port: number, listen: string) {
  const dataDir = await Deno.makeTempDir({ prefix: "pravda-desktop-srv-" });
  const child = new Deno.Command(binary, {
    args: ["--listen", `${listen}:${port}`, "--data", dataDir, "--tls-self-signed", "--media-udp", String(port + 1), "--media-tcp", "0", "--name", "Test Pravda"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  await until(`server on ${port}`, async () => {
    const conn = await Deno.connect({ hostname: listen, port });
    conn.close();
    return true;
  }, 20000);
  const pem = await Deno.readTextFile(`${dataDir}/selfsigned.crt`);
  return { child, dataDir, pem };
}

function fingerprintOfPem(pem: string): Promise<string> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.digest("SHA-256", der).then((d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${(err as Error).message}`);
    if (page) await page.screenshot({ path: `${shots}/desktop-fail-${name.replace(/\W+/g, "-").slice(0, 40)}.png` }).catch(() => {});
  }
}

const seesText = (p: Page, needle: string, timeout = 15000) =>
  until(`text "${needle}"`, () => p.evaluate((n) => document.body.innerText.toLowerCase().includes(n.toLowerCase()), needle), timeout);

async function clickText(p: Page, selector: string, label: string) {
  const handle = await until(`button "${label}"`, async () => {
    for (const h of await p.$$(selector)) {
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

async function type(p: Page, selector: string, value: string) {
  const el = await until(`input ${selector}`, () => p.$(selector));
  await el!.click({ count: 3 });
  await p.keyboard.press("Backspace");
  await el!.type(value);
}

const splashGone = (p: Page) => until("the opening animation to finish", () => p.evaluate(() => !document.querySelector(".splash")), 15000);

// ---- run ----
const serverA = await startServer(18471, "127.0.0.1");
const serverB = await startServer(18472, "127.0.0.2");
const profile = await Deno.makeTempDir({ prefix: "pravda-desktop-profile-" });
// Server A's certificate is trusted up front; B is left for the prompt.
await Deno.writeTextFile(`${profile}/certificate-pins.json`, JSON.stringify({ "127.0.0.1": await fingerprintOfPem(serverA.pem) }));

const app = new Deno.Command(electron, {
  // The private test session has no keyring, so use Chromium's basic store.
  args: [`${repo}desktop`, "--ozone-platform=wayland", "--disable-gpu", "--remote-debugging-port=9333", "--password-store=basic"],
  env: {
    PRAVDA_USER_DATA: profile,
    // A packaged build hosts with the server it carries; set
    // PRAVDA_TEST_BUNDLED_SERVER=1 to test that one instead.
    ...(Deno.env.get("PRAVDA_TEST_BUNDLED_SERVER") === "1" ? {} : { PRAVDA_SERVER: binary }),
    PRAVDA_HOST_PORT: "18481",
    PRAVDA_MEDIA_PORT: "18482",
    ELECTRON_ENABLE_LOGGING: "1",
  },
  stdout: "piped",
  stderr: "piped",
}).spawn();
const appLog: string[] = [];
(async () => {
  for await (const chunk of app.stderr.pipeThrough(new TextDecoderStream())) appLog.push(chunk);
})();
(async () => {
  for await (const chunk of app.stdout.pipeThrough(new TextDecoderStream())) appLog.push(chunk);
})();

let browser: Browser | null = null;
let page: Page | null = null;
let secret = "";
try {
  browser = await until("the debugging port", () => puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null, protocolTimeout: 30000 }), 30000);
  const appPage = (await until("the app page", async () => (await browser!.pages()).find((p) => p.url().startsWith("app://pravda/")) ?? null, 20000))!;
  page = appPage;
  const errors: string[] = [];
  appPage.on("pageerror", (e) => errors.push((e as Error).message));

  console.log("\nDesktop app");
  await check("opens on the server picker", async () => {
    await until("picker", () => page!.$(".instances"), 20000);
    await splashGone(page!);
    await page!.screenshot({ path: `${shots}/desktop-01-picker.png` });
  });
  await check("adds a server with a pinned self-signed certificate", async () => {
    await type(page!, ".instances form input", "127.0.0.1:18471");
    await clickText(page!, ".instances form button", "Connect");
    await until("the sign-in page after reload", async () => (await page!.$(".auth-poster")) && (await page!.$('input[autocomplete="new-password"]')), 30000);
    await seesText(page!, "first account created runs it");
    await splashGone(page!);
    await page!.screenshot({ path: `${shots}/desktop-02-signin.png` });
  });
  await check("registers with the authenticator", async () => {
    await type(page!, 'input[autocomplete="username"]', "nadia");
    await type(page!, 'input[autocomplete="nickname"]', "Nadia");
    const pw = await page!.$$('input[autocomplete="new-password"]');
    await pw[0].type("correct horse battery staple");
    await pw[1].type("correct horse battery staple");
    await clickText(page!, "button", "Create account");
    await seesText(page!, "Your recovery key", 30000);
    await page!.click(".secret-sheet .check input");
    await clickText(page!, "button", "Continue");
    secret = (await until("authenticator secret", () => page!.$eval(".secret-inline", (el) => el.textContent ?? ""))).replace(/\s/g, "");
    await type(page!, ".code-input", await totp(secret));
    await clickText(page!, "button", "Confirm");
    await seesText(page!, "recovery codes");
    await page!.click(".secret-sheet .check input");
    await clickText(page!, "button", "Continue");
    await seesText(page!, "Direct messages", 20000);
    await page!.screenshot({ path: `${shots}/desktop-03-app.png` });
  });
  await check("keeps the session token encrypted on disk", async () => {
    const tokens = JSON.parse(await Deno.readTextFile(`${profile}/tokens.json`));
    const entry = tokens["https://127.0.0.1:18471"];
    if (!entry?.enc) throw new Error(`no encrypted token: ${JSON.stringify(tokens).slice(0, 120)}`);
  });
  await check("a reload restores the session from the keychain", async () => {
    await page!.reload();
    await seesText(page!, "Direct messages", 20000);
  });
  await check("switching servers returns to the picker, which lists the server", async () => {
    await splashGone(page!);
    await page!.click(".user-card");
    await clickText(page!, ".menu-item", "Switch server");
    await until("picker", () => page!.$(".instances .pick"), 20000);
    await seesText(page!, "Test Pravda");
  });
  await check("hosts a server on this computer and shows how friends connect", async () => {
    await splashGone(page!);
    await clickText(page!, ".host-box button", "Start hosting");
    await seesText(page!, "Your server is running", 30000);
    await seesText(page!, "fingerprint");
    await page!.screenshot({ path: `${shots}/desktop-04-hosting.png` });
    await clickText(page!, ".host-box button", "Open my server");
    await until("the hosted server's sign-in", () => page!.$('input[autocomplete="new-password"]'), 30000);
    await seesText(page!, "first account created runs it");
  });
  await check("asks before trusting an unknown certificate", async () => {
    await page!.evaluate(() => (globalThis as unknown as { pravdaDesktop: { switchInstance: () => void } }).pravdaDesktop.switchInstance());
    await until("picker", () => page!.$(".instances form input"), 20000);
    await splashGone(page!);
    await type(page!, ".instances form input", "127.0.0.2:18472");
    await clickText(page!, ".instances form button", "Connect");
    await sleep(2500);
    // The native prompt is outside the page: capture the whole screen.
    const shot = await new Deno.Command("spectacle", { args: ["-b", "-n", "-f", "-o", `${shots}/desktop-05-trust-prompt.png`], env: { QT_QPA_PLATFORM: "wayland" } }).output();
    if (!shot.success) throw new Error("spectacle failed");
    const stillWaiting = await page!.evaluate(() => !!document.querySelector(".instances form button[disabled]"));
    if (!stillWaiting) throw new Error("the app did not wait for the trust prompt");
  });
  await check("no uncaught errors in the app", () => {
    if (errors.length) throw new Error(errors.slice(0, 4).join(" | "));
    return Promise.resolve();
  });
} finally {
  await browser?.disconnect().catch(() => {});
  try {
    app.kill("SIGTERM");
  } catch { /* gone */ }
  const status = await Promise.race([app.status, sleep(8000).then(() => null)]);
  if (!status) {
    console.log("  note  the app did not quit within 8 s");
    app.kill("SIGKILL");
  }
  // Quitting must also stop the server it was hosting.
  await sleep(1000);
  const hostedLeft = await Deno.connect({ hostname: "127.0.0.1", port: 18481 }).then((c) => (c.close(), true), () => false);
  if (hostedLeft) {
    failures++;
    console.log("  FAIL  the hosted server outlived the app");
  } else {
    console.log("  ok    quitting stops the hosted server");
  }
  for (const s of [serverA, serverB]) {
    s.child.kill("SIGTERM");
    await s.child.status;
    await Deno.remove(s.dataDir, { recursive: true }).catch(() => {});
  }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
  if (failures) console.log(appLog.join("").split("\n").filter((l) => /error|Error|warn/i.test(l)).slice(-15).join("\n"));
  console.log(failures ? `\n${failures} failed` : "\nall desktop checks passed");
  Deno.exit(failures ? 1 : 0);
}
