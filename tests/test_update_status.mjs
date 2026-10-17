import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import updateStatus, { fixRequest, updateWarning, unseenNotes, updateIsRunning } from "../extensions/update-status.ts";

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-28T09:00:00Z");
const status = (overrides) => ({
  finishedAt: "2026-09-28T03:10:00Z",
  ok: true,
  log: "~/Library/Logs/pi-update.log",
  steps: [
    { name: "homebrew", ok: true, detail: "" },
    { name: "pi", ok: true, detail: "" },
  ],
  ...overrides,
});

assert.equal(updateWarning(status(), now), undefined);
assert.match(updateWarning(undefined, now), /No Vibes update has been recorded/);
const home = status({ updater: "home", log: "~/Library/Logs/pi-personal-update.log" });
const homeOverdue = updateWarning({ ...home, finishedAt: new Date(now - 4 * day).toISOString() }, now);
assert.match(homeOverdue, /vibes update/);
assert.match(homeOverdue, /vibes status/);
assert.doesNotMatch(homeOverdue, /vibes refresh|catches up after login/);
const homeFailure = { ...home, steps: [{ name: "packages", ok: false, detail: "exit 1" }] };
assert.match(fixRequest(homeFailure, "/s/1.jsonl"), /personal Vibes update/);
assert.match(fixRequest(homeFailure, "/s/1.jsonl"), /Then run `vibes update`/);
assert.doesNotMatch(fixRequest(homeFailure, "/s/1.jsonl"), /vibes report|maintainers/);
assert.match(
  updateWarning(status({ ok: false, steps: [{ name: "homebrew", ok: true, detail: "" }, { name: "pi", ok: false, detail: "exit 1" }] }), now),
  /failed: pi\./,
);
assert.match(updateWarning(status({ finishedAt: new Date(now - 4 * day).toISOString() }), now), /ran on .*Mac was off.*catches up/);
assert.equal(updateWarning(status({ finishedAt: new Date(now - 2 * day).toISOString() }), now), undefined);
const failedPi = status({ ok: false, steps: [{ name: "homebrew", ok: true, detail: "" }, { name: "pi", ok: false, detail: "exit 1" }] });
assert.match(fixRequest(failedPi, "/s/1.jsonl"), /failed at: pi\./);
assert.match(fixRequest(failedPi, "/s/1.jsonl"), /pi-update\.log/);
assert.doesNotMatch(fixRequest(failedPi, "/s/1.jsonl"), /Migrate duplicate resources/);
assert.match(fixRequest(status({ ok: false, steps: [{ name: "startup", ok: false, detail: "collision" }] }), "/s/1.jsonl"), /\/docs\/existing-setups\.md/);
assert.match(fixRequest(failedPi, "/s/1.jsonl"), /vibes report '\/s\/1\.jsonl'/);
assert.match(fixRequest(failedPi, "/s/1.jsonl"), /Then run `vibes update`/);
const pr = "The nightly update moved local work from ~/projects/commercial into a PR: https://github.com/example/commercial/pull/7. Kept the edit.";
assert.deepEqual(unseenNotes(status({ notes: [pr] }), undefined), [pr]);
assert.deepEqual(unseenNotes(status({ notes: [pr] }), "2026-09-27T03:10:00Z"), [pr]);
assert.deepEqual(unseenNotes(status({ notes: [pr] }), "2026-09-28T03:10:00Z"), []);
assert.deepEqual(unseenNotes(status(), undefined), []);
// write_status carries notes Pi hasn't shown into the next status.
const dir = mkdtempSync(path.join(os.tmpdir(), "vibes-status-"));
const file = path.join(dir, "vibes-update.json");
const write = (...notes) =>
  execFileSync("/bin/bash", ["-c", 'source scripts/vibes; STATUS_FILE=$1 NOTES_FILE=$1.notes; shift; record commercial ok ""; for n in "$@"; do note "$n" >/dev/null; done; write_status true', "_", file, ...notes]);
const template = path.resolve("AGENTS.template.md");
const hash = createHash("sha256").update(readFileSync(template)).digest("hex");
const writeWithTemplate = () =>
  execFileSync("/bin/bash", ["-c", 'source scripts/vibes; STATUS_FILE=$1 NOTES_FILE=$1.notes; write_status true "$2"', "_", file, template]);
writeWithTemplate();
assert.equal(JSON.parse(readFileSync(file, "utf8")).agentsTemplateHash, hash);
write();
assert.equal(JSON.parse(readFileSync(file, "utf8")).agentsTemplateHash, undefined);
const notes = () => JSON.parse(readFileSync(file, "utf8")).notes;
write("first");
write();
assert.deepEqual(notes(), ["first"]);
write("second");
assert.deepEqual(notes(), ["first", "second"]);
writeFileSync(path.join(dir, "vibes-update-seen"), JSON.parse(readFileSync(file, "utf8")).finishedAt + "\n");
write();
assert.deepEqual(notes(), []);
// A note left by an interrupted run is picked up by the next status.
execFileSync("/bin/bash", ["-c", 'source scripts/vibes; NOTES_FILE=$1.notes; note interrupted >/dev/null', "_", file]);
write();
assert.deepEqual(notes(), ["interrupted"]);
// A failed update goes to the agent once per failure, and never from the hidden `vibes check` Pi.
const agent = mkdtempSync(path.join(os.tmpdir(), "vibes-agent-"));
process.env.PI_CODING_AGENT_DIR = agent;
const start = async (hidden, endTurn = true, mode = "tui") => {
  const sent = [], warned = [];
  let handler;
  const finish = [];
  updateStatus({ on: (event, h) => event === "session_start" ? (handler = h) : finish.push({ event, h }), sendMessage: (message, options) => sent.push({ message, options }) });
  if (hidden) process.env.VIBES_CHECK_READY = "1"; else delete process.env.VIBES_CHECK_READY;
  await handler({ type: "session_start", reason: "startup" }, { mode, hasUI: true, sessionManager: { getSessionFile: () => "/s/1.jsonl" }, ui: { notify: (text) => warned.push(text) } });
  const emit = async (event) => { for (const entry of finish) if (entry.event === event) await entry.h(); };
  const release = () => emit("agent_settled");
  if (endTurn) await release();
  return { sent, warned, release, emit };
};
// New and legacy upload-only failures are notices, never repair turns. The CLI agrees.
for (const ok of [false, true]) {
  for (const names of [["telemetry"], ["usage-telemetry"], ["telemetry", "usage-telemetry"]]) {
    const pending = status({ ok, finishedAt: new Date().toISOString(), steps: [
      { name: "pi", ok: true, detail: "" },
      ...names.map((name) => ({ name, ok: false, detail: "exit 1" })),
    ] });
    writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(pending));
    const result = await start(false);
    assert.deepEqual(result.sent, []);
    assert.match(result.warned[0], /Update succeeded; telemetry upload pending.*hourly.*vibes refresh/);
    const cli = execFileSync("bash", ["scripts/vibes", "status"], { encoding: "utf8" });
    assert.match(cli, /Update succeeded; telemetry upload pending.*hourly.*vibes refresh/);
    assert.doesNotMatch(cli, /\(failed\)/);
  }
}
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({
  ok: false, finishedAt: new Date(Date.now() - 4 * day).toISOString(),
  steps: [{ name: "telemetry", ok: false, detail: "exit 1" }],
})));
const overdueUpload = await start(false);
assert.deepEqual(overdueUpload.sent, []);
assert.match(overdueUpload.warned[0], /updates stay overdue/);
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ ok: false, steps: [
  { name: "startup", ok: false, detail: "exit 1" },
  { name: "telemetry", ok: false, detail: "exit 1" },
] })));
assert.equal((await start(false)).sent[0].message.customType, "vibes-update-failed");
assert.match(execFileSync("bash", ["scripts/vibes", "status"], { encoding: "utf8" }), /\(failed\)/);
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ ok: false, finishedAt: new Date().toISOString(), steps: [{ name: "startup", ok: false, detail: "exit 1" }] })));
let run = await start(true);
assert.equal(run.sent.length, 0);
assert.equal((await start(false, true, "rpc")).sent.length, 0, "RPC must not start unsolicited repair turns");
run = await start(false);
assert.equal(run.sent.length, 1);
assert.equal(run.sent[0].options.triggerTurn, true);
assert.match(run.sent[0].message.content, /failed at: startup\./);
run = await start(false);
assert.equal(run.sent.length, 0);
assert.match(run.warned[0], /failed: startup\./);

// One repair at a time: a second session waits for the first repair turn to settle, without
// consuming its once-per-failure marker.
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ ok: false, finishedAt: "2026-10-01T12:00:00Z", steps: [{ name: "startup", ok: false, detail: "collision" }] })));
const repairing = await start(false, false);
assert.equal(repairing.sent.length, 1);
await repairing.emit("agent_end"); // a retry/compaction boundary is not final settlement
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ ok: false, finishedAt: "2026-10-01T12:01:00Z", steps: [{ name: "startup", ok: false, detail: "collision" }] })));
const competing = await start(false);
assert.equal(competing.sent.length, 0, "another repair owns the lock even across agent_end");
assert.match(competing.warned[0], /Another Pi session is already repairing/);
assert.equal(readFileSync(path.join(agent, "vibes-update-fixing"), "utf8").trim(), "2026-10-01T12:00:00Z");
await repairing.release();
assert.equal((await start(false)).sent.length, 1, "retry after the owning turn ends");

// Startup alone cannot request a review. Only a successful `vibes update` recording the installed
// template can request it; the hidden check and failed update defer it, and each hash is shown once.
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ finishedAt: new Date().toISOString() })));
writeFileSync(path.join(agent, "AGENTS.md"), "# Mine\n");
run = await start(false);
assert.equal(run.sent.length, 0);
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ agentsTemplateHash: "different", finishedAt: new Date().toISOString() })));
run = await start(false);
assert.equal(run.sent.length, 0);
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ agentsTemplateHash: hash, finishedAt: new Date().toISOString() })));
run = await start(true);
assert.equal(run.sent.length, 0);
run = await start(false);
assert.equal(run.sent.length, 1);
assert.equal(run.sent[0].message.customType, "vibes-agents-changed");
assert.equal(run.sent[0].options.triggerTurn, true);
run = await start(false);
assert.equal(run.sent.length, 0);
writeFileSync(path.join(agent, "vibes-agents-reviewed"), "an older template\n");
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ ok: false, agentsTemplateHash: hash, finishedAt: new Date().toISOString(), steps: [{ name: "pi", ok: false, detail: "exit 1" }] })));
run = await start(false);
assert.deepEqual(run.sent.map((s) => s.message.customType), ["vibes-update-failed"]);
run = await start(false);
assert.equal(run.sent.length, 0);
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify(status({ agentsTemplateHash: hash, finishedAt: new Date().toISOString() })));
run = await start(false);
assert.deepEqual(run.sent.map((s) => s.message.customType), ["vibes-agents-changed"]);
// Home updates do not propose replacing personal instructions, even with a legacy template hash.
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify({ ...home, finishedAt: new Date().toISOString(), agentsTemplateHash: hash }));
writeFileSync(path.join(agent, "vibes-agents-reviewed"), "old hash\n");
assert.deepEqual((await start(false)).sent, []);
const homeCli = execFileSync("bash", ["scripts/home-vibes", "status"], { encoding: "utf8" });
assert.match(homeCli, /Last update:.*succeeded/);
assert.match(homeCli, /pi-personal-update\.log/);
writeFileSync(path.join(agent, "vibes-update.json"), JSON.stringify({ ...homeFailure, finishedAt: new Date().toISOString() }));
const homeRepair = await start(false);
assert.equal(homeRepair.sent[0].message.customType, "vibes-update-failed");
assert.doesNotMatch(homeRepair.sent[0].message.content, /vibes report|maintainers/);
// A real kernel lock suppresses stale warnings/repair turns during login catch-up. A crash
// releases it automatically; a leftover file alone must not suppress anything.
assert.equal(updateIsRunning(), false);
const lockFile = path.join(agent, "vibes-update.flock");
writeFileSync(lockFile, "");
const holder = spawn("/usr/bin/perl", ["-MFcntl=:flock", "-e", 'open(my $l, "+<", $ARGV[0]) or die $!; flock($l, LOCK_EX) or die $!; $|=1; print "ready\\n"; sleep 60;', lockFile]);
try {
  await new Promise((resolve, reject) => { holder.stdout.once("data", resolve); holder.once("error", reject); });
  assert.equal(updateIsRunning(), true);
  const catchingUp = await start(false);
  assert.deepEqual(catchingUp.sent, []);
  assert.deepEqual(catchingUp.warned, []);
} finally {
  const exited = new Promise((resolve) => holder.once("exit", resolve));
  holder.kill("SIGKILL");
  await exited;
}
assert.equal(updateIsRunning(), false);
console.log("ok");
