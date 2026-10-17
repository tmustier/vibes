import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
const PROFILE_ROOT = join(BROWSER_ROOT, "chrome-profile");
const ACTIVE_PORT_FILE = join(PROFILE_ROOT, "DevToolsActivePort");
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

function readActivePort(): number | null {
  try {
    return parseActivePort(readFileSync(ACTIVE_PORT_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function endpointIsLive(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function acquireLaunchLock(): boolean {
  try {
    mkdirSync(LAUNCH_LOCK, { mode: 0o700 });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(LAUNCH_LOCK).mtimeMs > 30_000) {
        rmSync(LAUNCH_LOCK, { recursive: true, force: true });
        mkdirSync(LAUNCH_LOCK, { mode: 0o700 });
        return true;
      }
    } catch {
      // Another process may have released the lock between checks.
    }
    return false;
  }
}

function releaseLaunchLock(): void {
  rmSync(LAUNCH_LOCK, { recursive: true, force: true });
}

async function waitForActivePort(timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readActivePort();
    if (port && (await endpointIsLive(port))) return port;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error("Timed out waiting for the persistent Pi browser to start.");
}

async function ensureChromeProcess(): Promise<number> {
  ensurePrivateDirectory(BROWSER_ROOT);
  ensurePrivateDirectory(PROFILE_ROOT);
  ensurePrivateDirectory(ARTIFACT_ROOT);

  const existing = readActivePort();
  if (existing && (await endpointIsLive(existing))) return existing;

  if (!existsSync(CHROME_EXECUTABLE)) {
    throw new Error(`Google Chrome was not found at ${CHROME_EXECUTABLE}.`);
  }

  const ownsLock = acquireLaunchLock();
  if (!ownsLock) return waitForActivePort();

  try {
    const rechecked = readActivePort();
    if (rechecked && (await endpointIsLive(rechecked))) return rechecked;
    rmSync(ACTIVE_PORT_FILE, { force: true });

    const child = spawn(
      CHROME_EXECUTABLE,
      [
        "--headless=new",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${PROFILE_ROOT}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "about:blank",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    return await waitForActivePort();
  } finally {
    releaseLaunchLock();
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
    if (browser?.isConnected() && context) {
      return { browser, context, port: readActivePort() ?? 0 };
    }
    if (connectionPromise) return connectionPromise;

    const pending = (async () => {
      playwright ??= await import("playwright");
      const port = await ensureChromeProcess();
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

  async function requirePage(id?: string, create = false): Promise<Page> {
    const page = findPage(id);
    if (page) {
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
      let installed = 0;
      let rejected = 0;
      // Install individually. Chrome's CDP can acknowledge a large setCookies
      // batch while silently dropping some valid cookies beside an invalid one.
      for (const cookie of state.cookies) {
        try {
          await connection.context.addCookies([cookie]);
          installed += 1;
        } catch {
          rejected += 1;
        }
      }
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
      const port = readActivePort();
      if (port && await endpointIsLive(port)) {
        playwright ??= await import("playwright");
        const resetConnection = browser?.isConnected()
          ? browser
          : await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        await resetConnection.close();
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && await endpointIsLive(port)) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
        }
        if (await endpointIsLive(port)) {
          throw new Error("Pi browser did not stop; its live profile was not moved.");
        }
      }
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
        const connection = await ensureConnection();
        await connection.browser.close();
        browser = undefined;
        context = undefined;
        activePage = undefined;
        ownedPages.clear();
        return { content: [{ type: "text" as const, text: "Stopped the persistent Pi browser. Its profile remains on disk." }], details: { action } };
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
    },
  });
}
