import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "vibes-pi-1-test-"));
const before = join(dir, "before.json"), after = join(dir, "after.json"), events = join(dir, "events.jsonl"), marker = join(dir, "verified.json"), proof = join(dir, "child-proof.txt");
const verify = () => spawnSync(process.execPath, [new URL("../scripts/verify-pi-1-migration.mjs", import.meta.url).pathname, before, after, events, marker, proof], { encoding: "utf8" }).status;
const list = (file, state) => writeFileSync(file, JSON.stringify({ servers: [{ name: "working", state }, { name: "already-needs-auth", state: "needs-auth" }] }));
const toolCalls = (...names) => writeFileSync(events, names.map((toolName) => JSON.stringify({ type: "tool_execution_start", toolName })).join("\n") + "\n");
try {
  list(before, "connected");
  list(after, "needs-auth");
  toolCalls("bash", "subagent");
  writeFileSync(proof, "PI1_CHILD_OK");
  assert.equal(verify(), 1, "a formerly connected server must not silently become needs-auth");
  assert.equal(existsSync(marker), false);
  list(after, "connected");
  assert.equal(verify(), 0, "a previously broken server need not block this upgrade");
  assert.ok(existsSync(marker));
  rmSync(marker);
  toolCalls("exec_command", "subagent");
  assert.equal(verify(), 0, "Codex-conversion shell tool is also valid proof");
  rmSync(marker);
  rmSync(proof);
  assert.equal(verify(), 1, "subagent invocation without a completed child must fail");
  writeFileSync(proof, "PI1_CHILD_OK");
  toolCalls();
  assert.equal(verify(), 1, "an idle model is not tool-use proof");
  assert.equal(existsSync(marker), false);
  console.log("ok: MCP regression detected, prior failures distinguished, shell tool and background child required");
} finally { rmSync(dir, { recursive: true, force: true }); }
