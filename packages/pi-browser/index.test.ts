import assert from "node:assert/strict";
import test from "node:test";
import {
  dismissDialogSafely,
  disconnectWithoutStopping,
  normalizeRef,
  parseActivePort,
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
