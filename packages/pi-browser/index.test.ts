import assert from "node:assert/strict";
import test from "node:test";
import {
  chromeArguments,
  dismissDialogSafely,
  disconnectWithoutStopping,
  isProfileChrome,
  normalizeRef,
  parseActivePort,
  parseOpenFiles,
  truncate,
} from "./index.ts";

test("parseActivePort validates DevToolsActivePort contents", () => {
  assert.equal(parseActivePort("49231\n/devtools/browser/abc\n"), 49231);
  assert.equal(parseActivePort("0\n"), null);
  assert.equal(parseActivePort("70000\n"), null);
  assert.equal(parseActivePort("not-a-port\n"), null);
});

test("normalizeRef accepts only snapshot refs", () => {
  assert.equal(normalizeRef(" e12 "), "e12");
  assert.equal(normalizeRef(undefined), undefined);
  assert.throws(() => normalizeRef("e0"), /latest browser snapshot/);
  assert.throws(() => normalizeRef('e1"'), /latest browser snapshot/);
});

test("truncate bounds visible browser output", () => {
  assert.equal(truncate("short", 10), "short");
  const output = truncate("abcdefghijklmnopqrstuvwxyz", 20);
  assert.match(output, /truncated/);
  assert.ok(output.length < 60);
});

test("disconnect adapter closes only the pinned Playwright client transport", () => {
  let closed = false;
  const fakeBrowser = {
    _connection: {
      toImpl: () => ({ _connection: { close: () => { closed = true; } } }),
    },
  };
  disconnectWithoutStopping(fakeBrowser as never);
  assert.equal(closed, true);
  assert.throws(
    () => disconnectWithoutStopping({} as never),
    /verified CDP disconnect adapter/,
  );
});

test("dialog dismissal races cannot become unhandled rejections", async () => {
  let dismissals = 0;
  dismissDialogSafely({
    dismiss: async () => {
      dismissals += 1;
      throw new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing");
    },
  });

  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(dismissals, 1);
});

test("only Chrome for Testing uses the mock keychain", () => {
  // Chrome for Testing would prompt for its own Keychain item; the old Google
  // Chrome profile can only be read with Chrome's real Keychain item.
  assert.ok(chromeArguments("/profile", "mock").includes("--use-mock-keychain"));
  assert.ok(!chromeArguments("/profile", "macos").includes("--use-mock-keychain"));
  assert.ok(chromeArguments("/profile", "mock").includes("--user-data-dir=/profile"));
});

test("isProfileChrome accepts only a Chrome browser process with this profile's files open", () => {
  const chrome = "/Caches/ms-playwright/chromium-1/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const profile = "/Users/a/.pi/agent/browser/chrome-for-testing-profile";
  const listing = (executable: string, ...files: string[]) =>
    parseOpenFiles([`p1`, `fcwd`, `n/`, `ftxt`, `n${executable}`, ...files.flatMap((file, i) => [`f${i + 3}`, `n${file}`])].join("\n"));
  assert.ok(isProfileChrome(listing(chrome, `${profile}/Default/History`), profile));
  assert.ok(isProfileChrome(listing("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", `${profile}/Default/Cookies`), profile));
  // Arguments can name Pi's profile while Chrome uses another; only open files count.
  assert.ok(!isProfileChrome(listing(chrome, "/other/Default/History"), profile));
  assert.ok(!isProfileChrome(listing(chrome, `${profile} other/Default/History`), profile));
  assert.ok(!isProfileChrome(listing(chrome, `${profile}-other/Default/History`), profile));
  assert.ok(!isProfileChrome(listing("/usr/local/bin/node", `${profile}/Default/History`), profile));
  assert.ok(!isProfileChrome(listing(`${chrome} Helper`, `${profile}/Default/History`), profile));
  assert.ok(!isProfileChrome(parseOpenFiles(`p1\nf3\nn${profile}/Default/History`), profile));
  // A working directory inside Pi's profile is not an open profile file.
  assert.ok(!isProfileChrome(parseOpenFiles(`p1\nfcwd\nn${profile}/Default/sub\nftxt\nn${chrome}\nf3\nn/other/Default/History`), profile));
});
