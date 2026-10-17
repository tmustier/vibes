import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import papercut from "../extensions/papercut.ts";
import { NEW_HOOK, OLD_HOOK, patchRadiusWork } from "../lib/cache-safe-radius-work.mjs";

const packageName = "@earendil-works/pi-radius-work";
const scratch = mkdtempSync(join(tmpdir(), "vibes-prompt-deltas-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

function fixture(name, hook = OLD_HOOK, entry = `npm:${packageName}`) {
  const agent = join(scratch, name);
  write(join(agent, "settings.json"), JSON.stringify({ packages: [entry] }));
  const root = join(agent, "npm", "node_modules", packageName);
  write(join(root, "package.json"), JSON.stringify({ name: packageName, version: "0.1.18" }));
  const path = join(root, "extensions", "radius-google-workspaces.ts");
  write(path, `// Upstream login, command and status code is preserved.\n${hook}\n// End of upstream file.\n`);
  return { agent, root, path };
}

function promptEvent() {
  return {
    systemPrompt: "Existing prompt",
    systemPromptOptions: { sections: { existing: "Keep me" } },
  };
}

test("papercut adds one stable section without forcing the prompt or dropping its capabilities", () => {
  const handlers = new Map(), tools = new Map(), commands = new Map();
  papercut({
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
  });
  const event = promptEvent();
  for (let turn = 0; turn < 2; turn++) {
    assert.equal(handlers.get("before_agent_start")(event), undefined);
    assert.equal(event.systemPromptOptions.forceSystemPrompt, undefined);
    assert.equal(event.systemPrompt, "Existing prompt");
    assert.equal(event.systemPromptOptions.sections.existing, "Keep me");
    assert.match(event.systemPromptOptions.sections.papercut, /record it once with the papercut tool/);
  }
  assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ["existing", "papercut"]);
  assert.equal(typeof tools.get("papercut").execute, "function");
  assert.equal(typeof commands.get("papercuts-submit").handler, "function");
});

test("papercut captures locally without an automatic inbox or retry upload", async () => {
  const tools = new Map(), commands = new Map(), calls = [], notices = [];
  papercut({
    on: () => {},
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    getThinkingLevel: () => "medium",
    exec: async (command, args) => {
      calls.push({ command, args });
      return command === "pi"
        ? { code: 0, stdout: "1.3.0", stderr: "" }
        : { code: 0, stdout: JSON.stringify({ status: "recorded", displayTarget: "local fixture" }), stderr: "" };
    },
  });
  const tool = tools.get("papercut");
  assert.match(tool.description, /stay local/);
  const result = await tool.execute("capture", { note: "The fixture displayed unclear feedback." }, undefined, undefined, {
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "fixture", getEntries: () => [], getBranch: () => [] },
    getContextUsage: () => ({}),
  });
  const capture = calls.find(({ command }) => command === "python3");
  assert.ok(capture);
  assert.ok(!capture.args.includes("--submit-repo"));
  assert.match(result.content[0].text, /^Recorded locally/);
  assert.equal(result.details.submissionPending, false);
  const beforeRetry = calls.length;
  await commands.get("papercuts-submit").handler("", { ui: { notify: (text, level) => notices.push({ text, level }) } });
  assert.equal(calls.length, beforeRetry, "retry without an inbox must not execute a remote submission");
  assert.deepEqual(notices, [{ text: "No default papercut inbox is configured", level: "warning" }]);
});

test("optional official npm patch is targeted, idempotent and reapplies after a reinstall", () => {
  const { agent, path } = fixture("official", OLD_HOOK, { source: `npm:${packageName}@0.1.18`, extensions: ["!extensions/radius-image-generation.ts"] });
  const original = readFileSync(path, "utf8");
  assert.match(patchRadiusWork(agent), /Patched/);
  const patched = readFileSync(path, "utf8");
  assert.equal(patched, original.replace(OLD_HOOK, NEW_HOOK));
  assert.match(patchRadiusWork(agent), /already cache-safe/);
  assert.equal(readFileSync(path, "utf8"), patched);
  writeFileSync(path, original);
  assert.match(patchRadiusWork(agent), /Patched/);
  assert.equal(readFileSync(path, "utf8"), patched);
});

test("both Google Workspace branches preserve the exact guidance in a structured section", () => {
  for (const connections of [[], [{ email: "one@example.com" }], [{ email: "one@example.com" }, { email: "two@example.com" }]]) {
    const load = (hook) => {
      let handler;
      vm.runInNewContext(hook, { pi: { on: (_name, fn) => { handler = fn; } }, listGoogleWorkspaceConnections: () => connections });
      return handler;
    };
    const oldEvent = promptEvent(), newEvent = promptEvent();
    const oldText = load(OLD_HOOK)(oldEvent).systemPrompt;
    assert.equal(load(NEW_HOOK)(newEvent), undefined);
    assert.equal(newEvent.systemPromptOptions.forceSystemPrompt, undefined);
    assert.equal(newEvent.systemPromptOptions.sections.google_workspaces, oldText.slice(oldEvent.systemPrompt.length).trim());
    assert.equal(newEvent.systemPromptOptions.sections.existing, "Keep me");
  }
});

test("absent optional packages and deliberate git/local forks are untouched", () => {
  const absent = join(scratch, "absent");
  assert.match(patchRadiusWork(absent), /nothing to patch/);
  for (const [name, entry] of [["git-fork", "git:github.com/example/pi-radius-work"], ["local-fork", "/local/pi-radius-work"]]) {
    const { agent, path } = fixture(name, OLD_HOOK, entry);
    const original = readFileSync(path, "utf8");
    assert.match(patchRadiusWork(agent), /nothing to patch/);
    assert.equal(readFileSync(path, "utf8"), original);
  }
  const { agent, root } = fixture("missing-install");
  rmSync(root, { recursive: true });
  assert.match(patchRadiusWork(agent), /not installed/);
});

test("unknown upstream/custom hooks fail without changing the file", () => {
  const { agent, path } = fixture("unknown", OLD_HOOK.replace("const connections =", "const customConnections ="));
  const original = readFileSync(path, "utf8");
  assert.throws(() => patchRadiusWork(agent), /hook changed; left unchanged/);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("settings sync patches before adopting deferred loading, and stops on an unknown hook", () => {
  const previous = join(scratch, "previous-templates");
  const next = join(scratch, "next-templates");
  write(join(previous, "web-search.template.json"), JSON.stringify({ toolActivation: "eager" }));
  write(join(next, "web-search.template.json"), JSON.stringify({ toolActivation: "auto" }));
  const sync = (agent) => execFileSync(process.execPath, [new URL("../scripts/sync-settings.mjs", import.meta.url).pathname, previous, next, agent], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, VIBES_UPDATE_LOCKED: "" }, stdio: "pipe",
  });
  const known = fixture("sync-known");
  const config = join(known.agent, "web-search.json");
  write(config, JSON.stringify({ toolActivation: "eager", provider: "exa" }));
  sync(known.agent);
  assert.deepEqual(JSON.parse(readFileSync(config)), { toolActivation: "auto", provider: "exa" });
  assert.ok(readFileSync(known.path, "utf8").includes(NEW_HOOK));

  const unknown = fixture("sync-unknown", OLD_HOOK.replace("const connections =", "const customConnections ="));
  const untouched = join(unknown.agent, "web-search.json");
  write(untouched, JSON.stringify({ toolActivation: "eager", provider: "exa" }));
  const before = readFileSync(untouched, "utf8");
  assert.throws(() => sync(unknown.agent), /hook changed; left unchanged/);
  assert.equal(readFileSync(untouched, "utf8"), before);
});

test("an upstream structured hook needs no compatibility edit", () => {
  const { agent, path } = fixture("upstream-fixed", NEW_HOOK.replace("const lines =", "const lines = /* upstream */"));
  const original = readFileSync(path, "utf8");
  assert.match(patchRadiusWork(agent), /upstream cache-safe/);
  assert.equal(readFileSync(path, "utf8"), original);
});
