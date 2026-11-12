// macOS acceptance for packages/pi-browser: drives the real browser tool in a
// scratch HOME and checks the processes it leaves behind.
//   node --experimental-strip-types tests/pi_browser_acceptance.mjs
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (process.env.PI_BROWSER_ACCEPTANCE_CHILD !== "1") {
  const home = mkdtempSync(join(tmpdir(), "pi-browser-acceptance-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", import.meta.filename], {
    stdio: "inherit",
    env: {
      ...process.env,
      HOME: home,
      PI_BROWSER_ACCEPTANCE_CHILD: "1",
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), "Library/Caches/ms-playwright"),
    },
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  for (const pid of chromePids(home)) process.kill(pid, "SIGKILL"); // a paused Chrome ignores SIGTERM
  await waitFor(() => chromePids(home).length === 0, "scratch Chrome to exit");
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  process.exit(code);
}

function chromePids(root) {
  try {
    return execFileSync("pgrep", ["-f", "--", `--user-data-dir=${root}`], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).map(Number)
      .filter((pid) => !execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes("--type="));
  } catch {
    return [];
  }
}

function bundleId(pid) {
  const listing = execFileSync("lsappinfo", ["info", "-only", "bundleid", String(pid)], { encoding: "utf8" });
  return listing.match(/"CFBundleIdentifier"="([^"]*)"/)?.[1] ?? "";
}

async function waitFor(check, what) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

const { chromium } = await import("playwright");
const browserRoot = join(homedir(), ".pi/agent/browser");
const legacyProfile = join(browserRoot, "chrome-profile");
const profile = join(browserRoot, "chrome-for-testing-profile");

// 1. A login imported into the old Google Chrome profile, left running as the
// old extension left it. The scratch HOME has no login keychain, so every
// Chrome here must use the mock keychain or macOS shows "Keychain Not Found".
mkdirSync(legacyProfile, { recursive: true, mode: 0o700 });
spawn(CHROME, ["--headless=new", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${legacyProfile}`, "--no-first-run", "--use-mock-keychain", "about:blank"], { detached: true, stdio: "ignore" }).unref();
const legacyPort = await waitFor(() => existsSync(join(legacyProfile, "DevToolsActivePort")) && readFileSync(join(legacyProfile, "DevToolsActivePort"), "utf8").split("\n")[0], "legacy Chrome");
const seeded = await chromium.connectOverCDP(`http://127.0.0.1:${legacyPort}`);
await seeded.contexts()[0].addCookies([{ name: "pi_acceptance", value: "kept", domain: "example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 86_400, httpOnly: false, secure: true, sameSite: "Lax" }]);
const legacyPid = chromePids(legacyProfile)[0];
assert.equal(await waitFor(() => bundleId(legacyPid), "legacy Chrome to register"), "com.google.Chrome", "the old launch shares the user's Chrome app identity");

// 2. The real extension, as Pi loads it.
const tools = new Map();
const commands = new Map();
const pi = { registerCommand: (name, command) => commands.set(name, command), on() {}, registerTool: (tool) => tools.set(tool.name, tool), exec: async () => ({ code: 1, stdout: "", stderr: "" }) };
const { default: extension } = await import("../packages/pi-browser/index.ts");
extension(pi);
const browserTool = tools.get("browser");
const run = (params, signal) => browserTool.execute("acceptance", params, signal, () => {}, {});
// Calls against a hung Chrome must fail the test, not hang it.
const within = (promise, ms = 60_000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms).unref())]);

await run({ action: "open", url: "https://example.com/" });
const [pid] = chromePids(profile);
assert.ok(pid, "Pi browser runs on its own profile");
assert.equal(await waitFor(() => bundleId(pid), "Pi browser to register"), "com.google.chrome.for.testing", "Pi browser is not registered as the user's Google Chrome");
assert.deepEqual(chromePids(legacyProfile), [], "the old Google Chrome instance was stopped");
assert.equal(existsSync(legacyProfile), false, "the old profile left the browser root");
assert.equal(readdirSync(join(homedir(), ".Trash")).filter((name) => name.startsWith("pi-browser-chrome-profile-")).length, 1, "the old profile is in the Trash");

const status = await run({ action: "status" });
const port = status.details.port;
const check = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const cookie = (await check.contexts()[0].cookies("https://example.com/")).find((item) => item.name === "pi_acceptance");
assert.equal(cookie?.value, "kept", "the old profile's login moved across");

// 3. stop really stops Chrome.
const stopped = await run({ action: "stop" });
assert.match(stopped.content[0].text, /Stopped/);
await waitFor(() => chromePids(profile).length === 0, "Pi browser to exit");

// 3b. A SingletonLock naming a process that is not Pi's Chrome on this profile,
// a Chrome on a profile whose path extends this one (`<profile> other`, whose
// argument ps prints exactly like `<profile>` followed by `other`, or
// `<profile>-other`) or a non-browser process whose arguments name the profile,
// must not be killed. A stale DevToolsActivePort naming another profile's
// Chrome must not get that Chrome closed either.
const otherProfile = `${profile}-other`;
const spacedProfile = `${profile} other`;
const lockTo = (target) => {
  rmSync(join(profile, "SingletonLock"), { force: true });
  symlinkSync(`${hostname()}-${target}`, join(profile, "SingletonLock"));
};
const launchOther = (dir) => spawn(chromium.executablePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--use-mock-keychain", "about:blank"], { detached: true, stdio: "ignore" });
const other = launchOther(otherProfile);
const spaced = launchOther(spacedProfile);
const lookalike = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`], { stdio: "ignore" });
await waitFor(() => chromePids(otherProfile).includes(other.pid), "the other-profile Chrome");
await waitFor(() => chromePids(spacedProfile).includes(spaced.pid), "the spaced-profile Chrome");
const otherPortFile = await waitFor(() => existsSync(join(otherProfile, "DevToolsActivePort")) && readFileSync(join(otherProfile, "DevToolsActivePort"), "utf8"), "the other-profile Chrome's port");
writeFileSync(join(profile, "DevToolsActivePort"), otherPortFile);
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
for (const [name, target] of [["the Chrome on `<profile> other`", spaced.pid], ["the Chrome on `<profile>-other`", other.pid], ["the lookalike process", lookalike.pid]]) {
  lockTo(target);
  assert.match((await within(run({ action: "stop" }))).content[0].text, /not running/, `stop with the lock naming ${name}`);
  assert.ok(isAlive(target), `stop killed ${name}`);
  assert.ok(isAlive(other.pid), `stop with the lock naming ${name} closed the Chrome the stale port file names`);
}
rmSync(join(profile, "SingletonLock"), { force: true });
rmSync(join(profile, "DevToolsActivePort"), { force: true });
spaced.kill("SIGKILL");
lookalike.kill("SIGKILL");
await waitFor(() => chromePids(spacedProfile).length === 0, "the spaced-profile Chrome to exit");
rmSync(spacedProfile, { recursive: true, force: true, maxRetries: 5 });

// 4. The next action starts it again on the same profile, keeping the login.
await run({ action: "open", url: "https://example.com/" });
const restarted = await chromium.connectOverCDP(`http://127.0.0.1:${(await run({ action: "status" })).details.port}`);
assert.ok((await restarted.contexts()[0].cookies("https://example.com/")).some((item) => item.name === "pi_acceptance"), "the login survives a restart");

// 4a. While Pi's Chrome runs, a stale DevToolsActivePort naming another
// profile's Chrome must not get that Chrome closed; stop still ends Pi's.
const piChrome = chromePids(profile).find((pid) => pid !== other.pid);
assert.ok(piChrome, "Pi's Chrome runs");
writeFileSync(join(profile, "DevToolsActivePort"), otherPortFile);
assert.match((await within(run({ action: "stop" }))).content[0].text, /Stopped/);
assert.ok(isAlive(other.pid), "stop closed the Chrome the stale port file names");
assert.ok(!chromePids(profile).includes(piChrome), "stop ended Pi's Chrome");
other.kill("SIGKILL");
await waitFor(() => chromePids(otherProfile).length === 0, "the other-profile Chrome to exit");
rmSync(otherProfile, { recursive: true, force: true, maxRetries: 5 });
await run({ action: "open", url: "https://example.com/" });

// 4b. A Chrome that hangs under an open page is replaced on the next action on
// that page, which says the page was lost instead of waiting on it forever.
const underPage = chromePids(profile)[0];
process.kill(underPage, "SIGSTOP");
await assert.rejects(within(run({ action: "snapshot" }), 30_000), /pages were lost.*action=open/);
assert.ok(!chromePids(profile).includes(underPage), "the hung Chrome was killed");
assert.equal(chromePids(profile).length, 1, "a fresh Chrome replaced it");
assert.match((await within(run({ action: "tabs" }))).content[0].text, /^\[\]$/);

// 5. A hung Chrome after this session connected to it (paused, so it holds the profile but never answers) is
// replaced on the next action, and stop ends it without launching another.
const hung = chromePids(profile)[0];
process.kill(hung, "SIGSTOP");
await within(run({ action: "status" }));
assert.ok(!chromePids(profile).includes(hung), "the hung Chrome was killed");
assert.equal(chromePids(profile).length, 1, "a fresh Chrome replaced it");

process.kill(chromePids(profile)[0], "SIGSTOP");
assert.match((await within(run({ action: "stop" }))).content[0].text, /Stopped/);
assert.deepEqual(chromePids(profile), [], "stop ended the hung Chrome");
assert.match((await run({ action: "stop" })).content[0].text, /not running/);
assert.deepEqual(chromePids(profile), [], "stop does not start Chrome");

// 5b. stop finishes when Chrome hangs after answering its health check, here
// as soon as stop has connected to ask it to close.
await within(run({ action: "status" }));
const connectOverCDP = chromium.connectOverCDP;
chromium.connectOverCDP = async (...args) => {
  const connection = await connectOverCDP.apply(chromium, args);
  process.kill(chromePids(profile)[0], "SIGSTOP");
  return connection;
};
try {
  assert.match((await within(run({ action: "stop" }))).content[0].text, /Stopped/);
} finally {
  chromium.connectOverCDP = connectOverCDP;
}
assert.deepEqual(chromePids(profile), [], "stop ended the Chrome that hung during stop");

// 6. Escape ends an action at once, even while Chrome is hung.
await run({ action: "open", url: "https://example.com/" });
process.kill(chromePids(profile)[0], "SIGSTOP");
const escape = new AbortController();
const started = Date.now();
setTimeout(() => escape.abort(), 300);
await assert.rejects(within(run({ action: "status" }, escape.signal)), /cancelled/);
assert.ok(Date.now() - started < 2_000, `abort took ${Date.now() - started} ms`);
// The cancelled call is still replacing the hung Chrome; stop waits for it and
// then stops Chrome, rather than racing it and leaving the replacement running.
assert.match((await within(run({ action: "stop" }))).content[0].text, /Stopped/);
await new Promise((resolve) => setTimeout(resolve, 2_000));
assert.deepEqual(chromePids(profile), [], "nothing restarted Chrome after stop");
await within(run({ action: "status" }));

// 7. /browser-reset stops the running browser and moves its profile to the Trash.
const notices = [];
await commands.get("browser-reset").handler("", { hasUI: false, ui: { notify: (message) => notices.push(message) } });
assert.deepEqual(notices, ["Pi browser profile moved to Trash."]);
await waitFor(() => chromePids(profile).length === 0, "Pi browser to exit on reset");
assert.equal(existsSync(profile), false, "reset moved the profile");

console.log("pi-browser acceptance passed");
process.exit(0);
