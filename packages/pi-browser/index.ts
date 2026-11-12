import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  realpathSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Browser, BrowserContext, Cookie, Dialog, Locator, Page } from "playwright";

const ACTIONS = [
  "status",
  "open",
  "snapshot",
  "click",
  "fill",
  "press",
  "wait",
  "screenshot",
  "tabs",
  "close",
  "stop",
] as const;

type Action = (typeof ACTIONS)[number];
type PlaywrightModule = typeof import("playwright");
type PageRecord = { id: string; page: Page };
type ImportSummary = {
  counts: { read: number; matched: number; imported: number; skipped: number };
  domains: string[];
  errors: Array<{ domain?: string; error: string }>;
};

type ElementSnapshot = {
  ref: string;
  tag: string;
  role: string;
  name: string;
  type: string;
  href: string;
  placeholder: string;
  disabled: boolean;
};

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const IMPORTER_PATH = join(EXTENSION_DIR, "import_chrome_cookies.py");
const CHROME_EXECUTABLE = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_SOURCE_ROOT = join(homedir(), "Library/Application Support/Google/Chrome");
const BROWSER_ROOT = join(homedir(), ".pi/agent/browser");
// Pi's browser runs Playwright's Chrome for Testing, never Google Chrome.app. A
// second process of the user's Chrome bundle registers as com.google.Chrome, so
// macOS can deliver the user's links and Apple Events to the hidden instance.
const PROFILE_ROOT = join(BROWSER_ROOT, "chrome-for-testing-profile");
const ACTIVE_PORT_FILE = join(PROFILE_ROOT, "DevToolsActivePort");
const LEGACY_PROFILE_ROOT = join(BROWSER_ROOT, "chrome-profile");
const LEGACY_ACTIVE_PORT_FILE = join(LEGACY_PROFILE_ROOT, "DevToolsActivePort");
const LAUNCH_LOCK = join(BROWSER_ROOT, "launch.lock");
const ARTIFACT_ROOT = join(BROWSER_ROOT, "artifacts");
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_ELEMENTS = 120;

export function parseActivePort(contents: string): number | null {
  const firstLine = contents.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine || !/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export function truncate(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 25)).trimEnd()}\n… [truncated ${text.length - max} chars]`;
}

export function normalizeRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const normalized = ref.trim();
  if (!/^e[1-9]\d*$/.test(normalized)) {
    throw new Error("ref must come from the latest browser snapshot, for example e1.");
  }
  return normalized;
}

export function dismissDialogSafely(dialog: Pick<Dialog, "dismiss">): void {
  // Every Playwright client attached over CDP sees the same JavaScript dialog.
  // Another Pi process may dismiss it first, so the losing client must absorb
  // Chromium's "No dialog is showing" rejection instead of crashing Pi.
  void dialog.dismiss().catch(() => undefined);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function readActivePort(file = ACTIVE_PORT_FILE): number | null {
  try {
    return parseActivePort(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// agent-default (not a user rule): 2026-11-03. How long a Chrome that still holds
// the profile gets to answer before Pi treats it as hung and kills it.
const HUNG_CHROME_MS = 5_000;

async function endpointIsLive(port: number, timeoutMs = 1_000): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// agent-default (not a user rule): 2026-11-03. A lock older than this belongs to
// a crashed launcher; launching and migrating take well under a minute.
const STALE_LOCK_MS = 120_000;

async function acquireLaunchLock(): Promise<string> {
  const token = randomUUID();
  const deadline = Date.now() + STALE_LOCK_MS + 30_000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(LAUNCH_LOCK, { mode: 0o700 });
      writeFileSync(join(LAUNCH_LOCK, "owner"), token);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(LAUNCH_LOCK).mtimeMs > STALE_LOCK_MS) rmSync(LAUNCH_LOCK, { recursive: true, force: true });
      } catch {
        // The owner released the lock between the two checks.
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error("Timed out waiting for another Pi session to start the Pi browser.");
}

function releaseLaunchLock(token: string): void {
  let owner = "";
  try {
    owner = readFileSync(join(LAUNCH_LOCK, "owner"), "utf8");
  } catch {
    return;
  }
  if (owner === token) rmSync(LAUNCH_LOCK, { recursive: true, force: true });
}

const CHROME_PROCESS_NAMES = new Set(["Google Chrome for Testing", "Google Chrome", "Chromium"]);

const SUBPROCESS_TIMEOUT_MS = 2_000; // agent-default (not a user rule): 2026-11-04

// Chrome's SingletonLock symlink names the process holding the profile as
// <host>-<pid>. The pid may since belong to another process, so it counts only
// while it is a Chrome browser process with this profile's files open. Open files
// show the profile Chrome actually uses, which its arguments can misstate.
export function profileChromePid(profile: string): number | null {
  let pid: number;
  try {
    pid = Number(readlinkSync(join(profile, "SingletonLock")).split("-").at(-1));
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const listing = execFileSync("/usr/sbin/lsof", ["-nP", "-p", String(pid), "-F", "fn"], { encoding: "utf8", stdio: "pipe", timeout: SUBPROCESS_TIMEOUT_MS });
    return isProfileChrome(parseOpenFiles(listing), realpathSync(profile)) ? pid : null;
  } catch {
    return null;
  }
}

// lsof -F fn prints an f<descriptor> line before each n<path> line.
export function parseOpenFiles(listing: string): { executable: string | undefined; files: string[] } {
  let fd = "", executable: string | undefined;
  const files: string[] = [];
  for (const line of listing.split("\n")) {
    if (line.startsWith("f")) fd = line.slice(1);
    else if (line.startsWith("n")) {
      if (fd === "txt") executable ??= line.slice(1);
      // Only files Chrome opened: not its working directory or mapped libraries.
      else if (/^\d+$/.test(fd)) files.push(line.slice(1));
    }
  }
  return { executable, files };
}

// The browser process, not a helper, with a file open in this profile's Default
// profile folder (another profile's path can share this one as a prefix).
export function isProfileChrome({ executable, files }: { executable: string | undefined; files: string[] }, profile: string): boolean {
  return executable !== undefined && CHROME_PROCESS_NAMES.has(basename(executable))
    && files.some((file) => file.startsWith(`${profile}/Default/`));
}

// The process listening on the DevTools port, which a stale DevToolsActivePort
// file may name for another Chrome.
function devToolsPid(port: number): number | null {
  try {
    const pids = execFileSync("/usr/sbin/lsof", ["-nP", "-t", "-a", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: "pipe", timeout: SUBPROCESS_TIMEOUT_MS }).trim().split("\n");
    return pids.length === 1 ? Number(pids[0]) : null;
  } catch {
    return null;
  }
}

// A hung Chrome still holds the profile, so a new launch hands over to it and
// never answers. Kill it; its helper processes exit with it.
async function killProfileChrome(profile: string): Promise<boolean> {
  const pid = profileChromePid(profile);
  if (!pid) return false;
  process.kill(pid, "SIGKILL");
  await waitForExit(profile, pid);
  // Its tabs are gone with it. Without this, the next Chrome restores them as
  // after a crash, and Playwright's connectOverCDP can stall on that restore.
  rmSync(join(profile, "Default", "Sessions"), { recursive: true, force: true });
  return true;
}

async function waitForExit(profile: string, pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && profileChromePid(profile) === pid) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

// Stop Pi's Chrome without starting it: ask it to close and let it finish
// writing the profile; kill it only if it is hung or does not exit. The launch
// lock makes a launch already under way (say, from a cancelled call) finish
// first, so it can't start Chrome again after the stop.
async function stopProfileChrome(playwright: PlaywrightModule): Promise<boolean> {
  ensurePrivateDirectory(BROWSER_ROOT);
  const lock = await acquireLaunchLock();
  try {
    const pid = profileChromePid(PROFILE_ROOT);
    if (!pid) return false;
    // Ask Chrome to close only when the port is Pi's Chrome's. stopChrome gives
    // up on a Chrome that stops answering partway; kill that one at once rather
    // than wait for it to exit.
    const port = readActivePort();
    if (
      port !== null
      && devToolsPid(port) === pid
      && await endpointIsLive(port, HUNG_CHROME_MS)
      && await stopChrome(playwright, port).then(() => true, () => false)
    ) {
      await waitForExit(PROFILE_ROOT, pid);
    }
    await killProfileChrome(PROFILE_ROOT);
    return true;
  } finally {
    releaseLaunchLock(lock);
  }
}

export function untilAborted<T>(signal: AbortSignal | undefined, work: Promise<T>): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new Error("Browser operation cancelled."));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function waitForActivePort(file = ACTIVE_PORT_FILE, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readActivePort(file);
    if (port && (await endpointIsLive(port))) return port;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error("Timed out waiting for the persistent Pi browser to start.");
}

export function chromeArguments(profile: string, keychain: "mock" | "macos"): string[] {
  return [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    // Chrome for Testing would otherwise ask macOS Keychain for its own Safe
    // Storage item, a foreground prompt; Playwright launches it the same way.
    // The legacy Google Chrome profile was encrypted with Chrome's real
    // Keychain item, so reading it needs the macOS keychain.
    ...(keychain === "mock" ? ["--use-mock-keychain"] : []),
    "about:blank",
  ];
}

async function launchChrome(executable: string, profile: string, keychain: "mock" | "macos"): Promise<number> {
  const activePortFile = join(profile, "DevToolsActivePort");
  rmSync(activePortFile, { force: true });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, chromeArguments(profile, keychain), { detached: true, stdio: "ignore" });
    child.once("error", reject).once("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
  return waitForActivePort(activePortFile);
}

async function browserExecutable(playwright: PlaywrightModule): Promise<string> {
  const executable = playwright.chromium.executablePath();
  if (existsSync(executable)) return executable;
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  await new Promise<void>((resolvePromise, reject) => {
    spawn(process.execPath, [cli, "install", "chromium"], { stdio: "ignore" })
      .on("error", reject)
      .on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Installing Chrome for Testing failed (exit ${code}).`)));
  });
  return executable;
}

export async function stopChrome(playwright: PlaywrightModule, port: number): Promise<void> {
  // Browser.close() on a connectOverCDP browser only disconnects this client;
  // Chrome keeps running. Ask Chrome itself to exit, then wait for it. Chrome
  // can stop answering at any step, so each step is bounded and the client
  // transport is always closed.
  const connection = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: HUNG_CHROME_MS });
  try {
    const closing = connection.newBrowserCDPSession()
      .then((session) => session.send("Browser.close"))
      .then(() => true, () => true); // Chrome may drop the connection instead of answering.
    let timer: NodeJS.Timeout | undefined;
    const answered = await Promise.race([
      closing,
      new Promise<false>((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), HUNG_CHROME_MS); }),
    ]);
    clearTimeout(timer);
    if (!answered) throw new Error("Pi browser stopped answering.");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && await endpointIsLive(port)) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  } finally {
    try {
      disconnectWithoutStopping(connection);
    } catch {
      // Chrome already closed the transport.
    }
  }
  if (await endpointIsLive(port)) throw new Error("Pi browser did not stop.");
}

async function migrateLegacyProfile(playwright: PlaywrightModule, port: number): Promise<void> {
  // Read and close the old browser only when it is Chrome on the old profile;
  // a stale port file may name another browser.
  let legacyPort = readActivePort(LEGACY_ACTIVE_PORT_FILE);
  const legacyPid = profileChromePid(LEGACY_PROFILE_ROOT);
  if (!legacyPort || !legacyPid || devToolsPid(legacyPort) !== legacyPid || !(await endpointIsLive(legacyPort))) {
    legacyPort = await launchChrome(CHROME_EXECUTABLE, LEGACY_PROFILE_ROOT, "macos");
  }
  const legacy = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${legacyPort}`);
  const cookies = await legacy.contexts()[0]!.cookies();
  disconnectWithoutStopping(legacy);
  await stopChrome(playwright, legacyPort);

  const fresh = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const { installed } = await installCookies(fresh.contexts()[0]!, cookies);
  disconnectWithoutStopping(fresh);
  if (cookies.length > 0 && installed === 0) {
    throw new Error("No cookies from the old Pi browser profile could be installed; the old profile was kept.");
  }
  const trash = join(homedir(), ".Trash", `pi-browser-chrome-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  ensurePrivateDirectory(dirname(trash));
  renameSync(LEGACY_PROFILE_ROOT, trash);
}

async function installCookies(context: BrowserContext, cookies: Cookie[]): Promise<{ installed: number; rejected: number }> {
  let installed = 0;
  let rejected = 0;
  // Install individually. Chrome's CDP can acknowledge a large setCookies
  // batch while silently dropping some valid cookies beside an invalid one.
  for (const cookie of cookies) {
    try {
      await context.addCookies([cookie]);
      installed += 1;
    } catch {
      rejected += 1;
    }
  }
  return { installed, rejected };
}

async function ensureChromeProcess(playwright: PlaywrightModule): Promise<number> {
  ensurePrivateDirectory(BROWSER_ROOT);
  ensurePrivateDirectory(ARTIFACT_ROOT);

  const existing = readActivePort();
  if (existing && !existsSync(LEGACY_PROFILE_ROOT) && !existsSync(LAUNCH_LOCK) && (await endpointIsLive(existing))) {
    return existing;
  }

  const executable = await browserExecutable(playwright);
  const lock = await acquireLaunchLock();
  try {
    let port = readActivePort();
    if (!port || !(await endpointIsLive(port, HUNG_CHROME_MS))) {
      await killProfileChrome(PROFILE_ROOT);
      ensurePrivateDirectory(PROFILE_ROOT);
      port = await launchChrome(executable, PROFILE_ROOT, "mock");
    }
    // Logins imported into the old Google Chrome profile move across once. The
    // old profile stays until they are installed, so an interrupted move retries.
    if (existsSync(LEGACY_PROFILE_ROOT)) await migrateLegacyProfile(playwright, port);
    return port;
  } finally {
    releaseLaunchLock(lock);
  }
}

function chromeProfiles(): Array<{ directory: string; label: string }> {
  const labels = new Map<string, string>();
  try {
    const state = JSON.parse(readFileSync(join(CHROME_SOURCE_ROOT, "Local State"), "utf8"));
    const cache = state?.profile?.info_cache;
    if (cache && typeof cache === "object") {
      for (const [directory, info] of Object.entries(cache)) {
        const name = typeof (info as { name?: unknown })?.name === "string"
          ? (info as { name: string }).name
          : directory;
        labels.set(directory, name);
      }
    }
  } catch {
    // Fall back to directory names.
  }

  const candidates = ["Default", ...Array.from({ length: 50 }, (_, index) => `Profile ${index + 1}`)];
  return candidates
    .filter((directory) => existsSync(join(CHROME_SOURCE_ROOT, directory, "Cookies")) || existsSync(join(CHROME_SOURCE_ROOT, directory, "Network/Cookies")))
    .map((directory) => ({ directory, label: labels.get(directory) ?? directory }));
}

function parseImportArgs(raw: string): { profile?: string; domains: string[] } {
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) ?? [];
  if (tokens.length === 0) return { domains: [] };
  return { profile: tokens[0], domains: tokens.slice(1) };
}

function profileLabel(profile: { directory: string; label: string }): string {
  return profile.label === profile.directory
    ? profile.directory
    : `${profile.label} (${profile.directory})`;
}

export function disconnectWithoutStopping(browser: Browser | undefined): void {
  if (!browser) return;
  // Playwright 1.62.1 does not expose disconnect() for connectOverCDP. Close
  // only its client CDP transport, not Chrome's persistent process.
  const client = browser as Browser & {
    _connection?: { toImpl?: (value: Browser) => { _connection?: { close?: () => void } } };
  };
  const closeTransport = client._connection?.toImpl?.(browser)?._connection?.close;
  if (typeof closeTransport !== "function") {
    throw new Error("Installed Playwright no longer exposes the verified CDP disconnect adapter.");
  }
  closeTransport.call(client._connection?.toImpl?.(browser)?._connection);
}

function pageId(pageIds: WeakMap<Page, string>, page: Page): string {
  const existing = pageIds.get(page);
  if (existing) return existing;
  const id = `page_${randomUUID().slice(0, 8)}`;
  pageIds.set(page, id);
  return id;
}

async function title(page: Page): Promise<string> {
  return page.title().catch(() => "");
}

function resolveLocator(page: Page, ref: string | undefined, selector: string | undefined): Locator {
  const normalizedRef = normalizeRef(ref);
  if (normalizedRef) return page.locator(`[data-pi-ref="${normalizedRef}"]`).first();
  if (selector?.trim()) return page.locator(selector.trim()).first();
  throw new Error("Provide ref from the latest snapshot or a Playwright selector.");
}

async function snapshotPage(page: Page): Promise<{ url: string; title: string; text: string; elements: ElementSnapshot[] }> {
  const elements = await page.evaluate((maxElements) => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(
      "a[href],button,input,textarea,select,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='switch'],[contenteditable='true'],[tabindex]",
    ));
    const visible = candidates.filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }).slice(0, maxElements);

    document.querySelectorAll("[data-pi-ref]").forEach((element) => element.removeAttribute("data-pi-ref"));
    return visible.map((element, index) => {
      const ref = `e${index + 1}`;
      element.setAttribute("data-pi-ref", ref);
      const input = element instanceof HTMLInputElement ? element : null;
      const role = element.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: input?.type || "input", TEXTAREA: "textbox", SELECT: "combobox" }[element.tagName] ?? "");
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ")
        : "";
      const name = element.getAttribute("aria-label") || labelledText || input?.labels?.[0]?.innerText || element.innerText || element.getAttribute("title") || input?.value || "";
      return {
        ref,
        tag: element.tagName.toLowerCase(),
        role,
        name: name.replace(/\s+/g, " ").trim().slice(0, 240),
        type: input?.type || "",
        href: element instanceof HTMLAnchorElement ? element.href : "",
        placeholder: input?.placeholder || (element instanceof HTMLTextAreaElement ? element.placeholder : ""),
        disabled: "disabled" in element ? Boolean((element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement).disabled) : false,
      };
    });
  }, MAX_ELEMENTS);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  return { url: page.url(), title: await title(page), text: truncate(bodyText), elements };
}

function formatSnapshot(snapshot: Awaited<ReturnType<typeof snapshotPage>>): string {
  const elementLines = snapshot.elements.map((element) => {
    const fields = [
      `[ref=${element.ref}]`,
      element.role || element.tag,
      element.name ? `name=${JSON.stringify(element.name)}` : "",
      element.type ? `type=${element.type}` : "",
      element.placeholder ? `placeholder=${JSON.stringify(element.placeholder)}` : "",
      element.href ? `href=${element.href}` : "",
      element.disabled ? "disabled=true" : "",
    ].filter(Boolean);
    return `- ${fields.join(" ")}`;
  });
  return [
    `Browser page: ${snapshot.title || "(untitled)"}`,
    `URL: ${snapshot.url}`,
    "",
    "Interactive elements:",
    ...(elementLines.length ? elementLines : ["(none)"]),
    "",
    "Page text:",
    snapshot.text || "(empty)",
  ].join("\n");
}

export default function piBrowserExtension(pi: ExtensionAPI) {
  let playwright: PlaywrightModule | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let connectionPromise: Promise<{ browser: Browser; context: BrowserContext; port: number }> | undefined;
  let activePage: Page | undefined;
  const ownedPages = new Set<Page>();
  const dialogProtectedPages = new WeakSet<Page>();
  const pageIds = new WeakMap<Page, string>();

  function protectPageDialogs(page: Page): void {
    if (dialogProtectedPages.has(page)) return;
    dialogProtectedPages.add(page);
    page.on("dialog", dismissDialogSafely);
  }

  function protectContextDialogs(browserContext: BrowserContext): void {
    browserContext.on("page", protectPageDialogs);
    for (const page of browserContext.pages()) protectPageDialogs(page);
  }

  async function ensureConnection(): Promise<{ browser: Browser; context: BrowserContext; port: number }> {
    if (connectionPromise) return connectionPromise;

    const pending = (async () => {
      if (browser?.isConnected() && context) {
        const port = readActivePort();
        if (port && await endpointIsLive(port, HUNG_CHROME_MS)) return { browser, context, port };
        // Chrome stopped answering: drop the connection so the launch below
        // replaces it, rather than wait on a call that never returns.
        try {
          disconnectWithoutStopping(browser);
        } catch {
          // The transport is already gone.
        }
        browser = undefined;
        context = undefined;
        activePage = undefined;
        ownedPages.clear();
      }
      playwright ??= await import("playwright");
      const port = await ensureChromeProcess(playwright);
      const connectedBrowser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const connectedContext = connectedBrowser.contexts()[0];
      if (!connectedContext) {
        disconnectWithoutStopping(connectedBrowser);
        throw new Error("Persistent Pi Chrome opened without a browser context.");
      }
      protectContextDialogs(connectedContext);
      browser = connectedBrowser;
      context = connectedContext;
      connectedBrowser.on("disconnected", () => {
        if (browser !== connectedBrowser) return;
        browser = undefined;
        context = undefined;
        activePage = undefined;
        ownedPages.clear();
      });
      return { browser: connectedBrowser, context: connectedContext, port };
    })();
    connectionPromise = pending;
    try {
      return await pending;
    } finally {
      if (connectionPromise === pending) connectionPromise = undefined;
    }
  }

  function trackPage(page: Page): Page {
    if (ownedPages.has(page)) return page;
    ownedPages.add(page);
    pageIds.set(page, `page_${randomUUID().slice(0, 8)}`);
    page.on("popup", (popup) => {
      trackPage(popup);
    });
    page.on("close", () => {
      ownedPages.delete(page);
      if (activePage === page) activePage = [...ownedPages].at(-1);
    });
    activePage = page;
    return page;
  }

  async function createPage(url?: string): Promise<Page> {
    const connection = await ensureConnection();
    const page = trackPage(await connection.context.newPage());
    if (url) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return page;
  }

  function findPage(id?: string): Page | undefined {
    if (!id) return activePage && !activePage.isClosed() ? activePage : [...ownedPages].find((page) => !page.isClosed());
    return [...ownedPages].find((page) => pageId(pageIds, page) === id && !page.isClosed());
  }

  // Chrome may have stopped answering since this session opened its pages.
  // ensureConnection replaces a hung Chrome, and this session's pages go with
  // it; say so rather than wait on them or repeat the action on a fresh page.
  async function checkPagesAnswer(): Promise<void> {
    if (ownedPages.size === 0) return;
    await ensureConnection();
    if (ownedPages.size === 0) {
      throw new Error("The Pi browser stopped answering and was restarted, so this session's pages were lost. Use browser action=open to open the page again.");
    }
  }

  async function requirePage(id?: string, create = false): Promise<Page> {
    const page = findPage(id);
    if (page) {
      await checkPagesAnswer();
      activePage = page;
      return page;
    }
    if (id) throw new Error(`Unknown page_id ${id}. Use browser action=tabs.`);
    if (create) return createPage();
    throw new Error("No Pi browser page is open. Use browser action=open first.");
  }

  async function importCookies(profile: string, domains: string[]): Promise<ImportSummary & { installed: number; rejected: number }> {
    ensurePrivateDirectory(BROWSER_ROOT);
    const temporaryState = join(BROWSER_ROOT, `.chrome-import-${randomUUID()}.json`);
    try {
      const args = ["run", IMPORTER_PATH, "--profile", profile, "--output", temporaryState];
      for (const domain of domains) args.push("--domain", domain);
      const result = await pi.exec("uv", args, { timeout: 120_000 });
      let summary: ImportSummary;
      try {
        summary = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "");
      } catch {
        throw new Error("Chrome cookie importer returned an unreadable result.");
      }
      if (result.code !== 0) {
        throw new Error(`Chrome cookie import failed: ${summary.errors.map((error) => error.error).join(", ") || "unknown error"}`);
      }

      const state = JSON.parse(await readFile(temporaryState, "utf8")) as { cookies?: Cookie[] };
      if (!Array.isArray(state.cookies)) throw new Error("Chrome cookie importer did not produce valid browser state.");
      const connection = await ensureConnection();
      const { installed, rejected } = await installCookies(connection.context, state.cookies);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      return { ...summary, installed, rejected };
    } finally {
      await rm(temporaryState, { force: true });
    }
  }

  pi.registerCommand("browser-import", {
    description: "Import Chrome login cookies into Pi's persistent agent browser",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const parsed = parseImportArgs(rawArgs.trim());
      const profiles = chromeProfiles();
      if (profiles.length === 0) {
        ctx.ui.notify("No Chrome profiles with a Cookies database were found.", "error");
        return;
      }

      let profile = parsed.profile;
      if (!profile) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Use /browser-import <Chrome profile directory> [domain ...] in non-interactive mode.", "error");
          return;
        }
        const choices = profiles.map(profileLabel);
        const selected = await ctx.ui.select("Import cookies from which Chrome profile?", choices);
        if (!selected) return;
        profile = profiles[choices.indexOf(selected)]?.directory;
      }
      const match = profiles.find((candidate) => candidate.directory === profile || candidate.label === profile || profileLabel(candidate) === profile);
      if (!match) {
        ctx.ui.notify(`Chrome profile not found: ${profile}`, "error");
        return;
      }

      const scope = parsed.domains.length > 0 ? parsed.domains.join(", ") : "all sites";
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm(
          "Import Chrome login sessions?",
          `Import ${scope} from ${profileLabel(match)} into Pi's persistent agent browser?`,
        );
        if (!confirmed) return;
      }

      ctx.ui.setStatus("pi-browser", `importing Chrome cookies from ${match.directory}…`);
      try {
        const summary = await importCookies(match.directory, parsed.domains);
        ctx.ui.notify(
          `Imported ${summary.installed} Chrome cookies across ${summary.domains.length} domains into Pi browser${summary.rejected ? ` (${summary.rejected} rejected)` : ""}.`,
          summary.rejected ? "warning" : "info",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      } finally {
        ctx.ui.setStatus("pi-browser", undefined);
      }
    },
  });

  pi.registerCommand("browser-status", {
    description: "Show Pi persistent browser status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const connection = await ensureConnection();
        const cookies = await connection.context.cookies();
        ctx.ui.notify(`Pi browser is running on local CDP port ${connection.port} with ${cookies.length} cookies.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("browser-reset", {
    description: "Stop Pi browser and move its persistent profile to Trash",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.hasUI && !(await ctx.ui.confirm("Reset Pi browser?", "Stop it and move the imported browser profile to Trash?"))) return;
      playwright ??= await import("playwright");
      await connectionPromise?.catch(() => undefined);
      await stopProfileChrome(playwright);
      browser = undefined;
      context = undefined;
      activePage = undefined;
      ownedPages.clear();
      if (existsSync(PROFILE_ROOT)) {
        const trash = join(homedir(), ".Trash", `pi-browser-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        ensurePrivateDirectory(dirname(trash));
        renameSync(PROFILE_ROOT, trash);
      }
      ctx.ui.notify("Pi browser profile moved to Trash.", "info");
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...ownedPages].map((page) => page.close().catch(() => undefined)));
    ownedPages.clear();
    try {
      disconnectWithoutStopping(browser);
    } catch {
      // If the pinned private adapter ever changes, stop Chrome rather than
      // leave a client transport keeping Pi alive.
      await browser?.close().catch(() => undefined);
    }
    browser = undefined;
    context = undefined;
    connectionPromise = undefined;
    activePage = undefined;
  });

  pi.registerTool({
    name: "browser",
    label: "Persistent Browser",
    description: "Operate Pi's persistent agent-controlled Chrome. It shares cookies imported once with /browser-import. Use snapshot to get stable element refs, then click/fill by ref. Supports Playwright selectors when needed. Output is truncated to 12,000 characters.",
    promptSnippet: "Operate the persistent logged-in Pi Chrome browser; snapshot pages for element refs before clicking or filling",
    promptGuidelines: [
      "Use browser for authenticated browser UI when a direct API or purpose-built tool is not more effective.",
      "Call browser with action=snapshot after opening or navigating a page, then use returned refs for click and fill.",
      "Browser refs are page-specific and may change after navigation or major DOM updates; take another snapshot when a ref stops working.",
      "The browser uses a persistent shared cookie profile imported with /browser-import, while tabs are scoped to the current Pi session.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS, { description: "Browser operation." }),
      url: Type.Optional(Type.String({ description: "URL for open." })),
      page_id: Type.Optional(Type.String({ description: "Page id from tabs/open." })),
      new_tab: Type.Optional(Type.Boolean({ description: "Open URL in a new tab. Defaults to true when there is no active tab." })),
      ref: Type.Optional(Type.String({ description: "Element ref from the latest snapshot, such as e3." })),
      selector: Type.Optional(Type.String({ description: "Playwright selector fallback when no snapshot ref is available." })),
      value: Type.Optional(Type.String({ description: "Text for fill." })),
      key: Type.Optional(Type.String({ description: "Playwright key name for press, such as Enter or Meta+A." })),
      text: Type.Optional(Type.String({ description: "Visible text to wait for." })),
      delay_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000, description: "Explicit delay for wait." })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 120_000, description: "Operation timeout." })),
      full_page: Type.Optional(Type.Boolean({ description: "Capture a full-page screenshot." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("Browser operation cancelled.");
      // Escape aborts the call even while Chrome or a page is not answering.
      return untilAborted(signal, (async () => {
        const action = params.action as Action;
        const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT_MS;

        if (action === "status") {
          const connection = await ensureConnection();
          const cookies = await connection.context.cookies();
          return {
            content: [{ type: "text" as const, text: `Pi browser running: port=${connection.port}; imported cookies=${cookies.length}; session tabs=${ownedPages.size}; profile=${PROFILE_ROOT}` }],
            details: { action, port: connection.port, cookieCount: cookies.length, profile: PROFILE_ROOT },
          };
        }

        if (action === "stop") {
          playwright ??= await import("playwright");
          // A cancelled call may still be starting Chrome; let it finish so it
          // can't start Chrome again after the stop.
          await connectionPromise?.catch(() => undefined);
          const stopped = await stopProfileChrome(playwright);
          browser = undefined;
          context = undefined;
          activePage = undefined;
          ownedPages.clear();
          const text = stopped ? "Stopped the persistent Pi browser. Its profile remains on disk." : "The persistent Pi browser was not running.";
          return { content: [{ type: "text" as const, text }], details: { action, stopped } };
        }

        if (action === "open") {
          if (!params.url) throw new Error("browser open requires url.");
          let page: Page;
          if (params.new_tab === false && findPage(params.page_id)) {
            page = await requirePage(params.page_id);
            await page.goto(params.url, { waitUntil: "domcontentloaded", timeout });
          } else {
            page = await createPage(params.url);
          }
          const summary = { page_id: pageId(pageIds, page), url: page.url(), title: await title(page) };
          return { content: [{ type: "text" as const, text: `Opened ${summary.url}\npage_id=${summary.page_id}\ntitle=${summary.title}` }], details: { action, ...summary } };
        }

        if (action === "tabs") {
          await checkPagesAnswer();
          const tabs = await Promise.all([...ownedPages].filter((page) => !page.isClosed()).map(async (page) => ({
            page_id: pageId(pageIds, page),
            active: activePage === page,
            url: page.url(),
            title: await title(page),
          })));
          return { content: [{ type: "text" as const, text: JSON.stringify(tabs, null, 2) }], details: { action, tabs } };
        }

        const page = await requirePage(params.page_id, false);

        if (action === "snapshot") {
          const snapshot = await snapshotPage(page);
          return { content: [{ type: "text" as const, text: formatSnapshot(snapshot) }], details: { action, page_id: pageId(pageIds, page), url: snapshot.url, title: snapshot.title, elementCount: snapshot.elements.length } };
        }

        if (action === "click") {
          const locator = resolveLocator(page, params.ref, params.selector);
          const oldUrl = page.url();
          await locator.click({ timeout });
          await Promise.race([
            page.waitForLoadState("domcontentloaded", { timeout: Math.min(timeout, 3_000) }).catch(() => undefined),
            page.waitForTimeout(500),
          ]);
          return { content: [{ type: "text" as const, text: `Clicked ${params.ref ? `ref=${params.ref}` : params.selector}.\nurl=${page.url()}\ntitle=${await title(page)}` }], details: { action, oldUrl, url: page.url(), page_id: pageId(pageIds, page) } };
        }

        if (action === "fill") {
          if (params.value === undefined) throw new Error("browser fill requires value.");
          const locator = resolveLocator(page, params.ref, params.selector);
          await locator.fill(params.value, { timeout });
          return { content: [{ type: "text" as const, text: `Filled ${params.ref ? `ref=${params.ref}` : params.selector} with ${params.value.length} characters.` }], details: { action, page_id: pageId(pageIds, page), valueLength: params.value.length } };
        }

        if (action === "press") {
          if (!params.key) throw new Error("browser press requires key.");
          if (params.ref || params.selector) await resolveLocator(page, params.ref, params.selector).press(params.key, { timeout });
          else await page.keyboard.press(params.key);
          await page.waitForTimeout(250);
          return { content: [{ type: "text" as const, text: `Pressed ${params.key}.\nurl=${page.url()}` }], details: { action, page_id: pageId(pageIds, page), key: params.key, url: page.url() } };
        }

        if (action === "wait") {
          if (params.ref || params.selector) await resolveLocator(page, params.ref, params.selector).waitFor({ state: "visible", timeout });
          else if (params.text) await page.getByText(params.text, { exact: false }).first().waitFor({ state: "visible", timeout });
          else if (params.delay_ms !== undefined) await page.waitForTimeout(params.delay_ms);
          else await page.waitForLoadState("domcontentloaded", { timeout });
          return { content: [{ type: "text" as const, text: `Wait complete.\nurl=${page.url()}\ntitle=${await title(page)}` }], details: { action, page_id: pageId(pageIds, page), url: page.url() } };
        }

        if (action === "screenshot") {
          await mkdir(ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
          const path = join(ARTIFACT_ROOT, `${Date.now()}-${basename(pageId(pageIds, page))}.png`);
          const data = await page.screenshot({ path, type: "png", fullPage: params.full_page ?? false });
          return {
            content: [
              { type: "text" as const, text: `Screenshot saved to ${path}` },
              { type: "image" as const, data: data.toString("base64"), mimeType: "image/png" },
            ],
            details: { action, page_id: pageId(pageIds, page), path, url: page.url() },
          };
        }

        if (action === "close") {
          const id = pageId(pageIds, page);
          await page.close();
          return { content: [{ type: "text" as const, text: `Closed page ${id}.` }], details: { action, page_id: id } };
        }

        throw new Error(`Unsupported browser action: ${action}`);
      })());
    },
  });
}
