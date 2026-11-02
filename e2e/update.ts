// Tests the desktop app's self-update with real builds: an older AppImage
// finds a newer signed release on a local stand-in for GitHub's releases API,
// downloads it while the opening animation shows progress, replaces itself
// and starts again as the new version. A tampered manifest must be refused.
//
// Run through desktop-nested.sh (PRAVDA_NESTED_SCRIPT=update.ts) so it
// happens in a private KWin session:
//
//   PRAVDA_NESTED_SCRIPT=update.ts e2e/desktop-nested.sh <old.AppImage> <folder with the new release> <shots-dir>

/// <reference lib="dom" />
/// <reference lib="deno.ns" />
import puppeteer, { type Browser, type Page } from "npm:puppeteer-core@24";

const [oldAppImage, newRelease, shots] = Deno.args;
if (!oldAppImage || !newRelease || !shots) {
  console.error("usage: update.ts <old.AppImage> <new-release-folder> <shots-dir>");
  Deno.exit(2);
}
await Deno.mkdir(shots, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T> | T, timeout = 30000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last as T;
    } catch (err) {
      last = err;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

async function sha256(path: string) {
  const data = await Deno.readFile(path);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- the stand-in for GitHub ----
const port = 18491;
const base = `http://127.0.0.1:${port}`;
const files = [...Deno.readDirSync(newRelease)].filter((e) => e.isFile).map((e) => e.name);
const version = files.find((n) => n.endsWith("-update.json"))!.replace(/^Pravda-/, "").replace(/-update\.json$/, "");
const newAppImage = files.find((n) => n.endsWith(".AppImage"))!;
const releases = (prefix: string) => [{
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  html_url: `${base}/release`,
  assets: files.map((name) => ({ name, browser_download_url: `${base}${prefix}/files/${name}` })),
}];
const server = Deno.serve({ port, hostname: "127.0.0.1", onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/releases") return Response.json(releases(""));
  if (path === "/bad/releases") return Response.json(releases("/bad"));
  const m = /^(\/bad)?\/files\/(.+)$/.exec(path);
  if (m && files.includes(m[2])) {
    if (m[1] && m[2].endsWith("-update.json")) {
      // The same manifest with one byte changed: its signature no longer fits.
      const text = await Deno.readTextFile(`${newRelease}/${m[2]}`);
      return new Response(text.replace('"prerelease": false', '"prerelease": true '));
    }
    const file = await Deno.open(`${newRelease}/${m[2]}`);
    const { size } = await file.stat();
    return new Response(file.readable, { headers: { "content-length": String(size) } });
  }
  return new Response("not found", { status: 404 });
});

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${(err as Error).message}`);
  }
}

async function launch(appImage: string, feed: string, profile: string, debugPort: number) {
  const child = new Deno.Command(appImage, {
    args: ["--ozone-platform=wayland", "--disable-gpu", `--remote-debugging-port=${debugPort}`, "--password-store=basic"],
    env: { PRAVDA_USER_DATA: profile, PRAVDA_UPDATE_FEED: feed },
    stdout: "null",
    stderr: "null",
  }).spawn();
  return child;
}

const started = Date.now();
const note = (msg: string) => console.error(`    [${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

/** Gives up on a promise after `ms`, so a dead debugging connection cannot stall the test. */
function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} took longer than ${ms} ms`); })]);
}

async function attach(debugPort: number): Promise<{ browser: Browser; page: Page }> {
  const browser = await until("the debugging port", () => within(5000, puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null, protocolTimeout: 10000 }), "connecting"), 60000);
  const page = (await until("the app page", async () => (await within(5000, browser.pages(), "listing pages")).find((p) => p.url().startsWith("app://pravda/")) ?? null, 30000))!;
  note(`attached to port ${debugPort}`);
  return { browser, page };
}

const desktopState = (page: Page) => page.evaluate(() => (globalThis as unknown as { pravdaDesktop: { getUpdateState(): Promise<{ phase: string; version?: string; error?: string; updatedTo?: string }> } }).pravdaDesktop.getUpdateState());

console.log(`\nSelf-update to ${version}`);
const work = await Deno.makeTempDir({ prefix: "pravda-update-" });
try {
  const installed = `${work}/apps/Pravda.AppImage`;
  await Deno.mkdir(`${work}/apps`, { recursive: true });
  await Deno.copyFile(oldAppImage, installed);
  await Deno.chmod(installed, 0o755);
  const oldHash = await sha256(installed);

  await check("an older copy finds the signed release, shows progress, replaces itself and restarts", async () => {
    const child = await launch(installed, `${base}/releases`, `${work}/profile`, 9334);
    note('launched the old version');
    const { browser, page } = await attach(9334);
    const seen = new Set<string>();
    let gone = false;
    const quick = <T>(p: Promise<T>, fallback: T) => Promise.race([p.catch(() => fallback), sleep(1000).then(() => fallback)]);
    const watch = (async () => {
      for (let i = 0; i < 600 && !gone; i++) {
        const line = await quick(page.evaluate(() => document.querySelector(".splash-line")?.textContent ?? ""), "");
        if (line) seen.add(line.replace(/\d+%/, "N%"));
        if (line.startsWith("Downloading") && !seen.has("shot")) {
          seen.add("shot");
          await quick(page.screenshot({ path: `${shots}/update-downloading.png` }), undefined);
        }
        await sleep(50);
      }
    })();
    const exited = await Promise.race([child.status.then(() => true), sleep(120000).then(() => false)]);
    note(`old version exited: ${exited}; splash said: ${[...seen].join(' / ')}`);
    gone = true;
    await watch.catch(() => {});
    await within(3000, browser.disconnect(), 'disconnecting').catch(() => {});
    note('reattaching');
    if (!exited) throw new Error("the old version never quit to install");
    if (await sha256(installed) !== await sha256(`${newRelease}/${newAppImage}`)) throw new Error("the AppImage was not replaced with the new release");
    const again = await attach(9334);
    const v = await again.page.evaluate(() => (globalThis as unknown as { pravdaDesktop: { version: string } }).pravdaDesktop.version);
    const state = (await until("the updated notice", async () => {
      const s = await desktopState(again.page);
      return s.updatedTo ? s : null;
    }, 20000))!;
    await until("the toast", () => again.page.evaluate((v) => document.querySelector(".toast")?.textContent?.includes(`Updated to Pravda ${v}`), version), 15000);
    await again.page.screenshot({ path: `${shots}/update-done.png` }).catch(() => {});
    await again.browser.close();
    if (v !== version) throw new Error(`restarted as ${v}, expected ${version}`);
    if (state.updatedTo !== version) throw new Error(`the notice names ${state.updatedTo}`);
    if (![...seen].some((l) => l.startsWith("Checking for updates")) && ![...seen].some((l) => l.startsWith("Downloading"))) {
      throw new Error(`the opening animation never showed the update (saw: ${[...seen].join(" / ")})`);
    }
  });

  await check("a release whose manifest does not match its signature is refused", async () => {
    const copy = `${work}/apps2/Pravda.AppImage`;
    await Deno.mkdir(`${work}/apps2`, { recursive: true });
    await Deno.copyFile(oldAppImage, copy);
    await Deno.chmod(copy, 0o755);
    const child = await launch(copy, `${base}/bad/releases`, `${work}/profile2`, 9335);
    const { browser, page } = await attach(9335);
    const state = (await until("the refusal", async () => {
      const s = await desktopState(page);
      return s.phase === "error" ? s : null;
    }, 60000))!;
    await browser.close();
    await Promise.race([child.status, sleep(10000)]);
    if (!/signature/i.test(state.error ?? "")) throw new Error(`unexpected error: ${state.error}`);
    if (await sha256(copy) !== oldHash) throw new Error("the AppImage changed anyway");
  });
} finally {
  await server.shutdown();
  await Deno.remove(work, { recursive: true }).catch(() => {});
  console.log(failures ? `\n${failures} failed` : "\nall update checks passed");
  Deno.exit(failures ? 1 : 0);
}
