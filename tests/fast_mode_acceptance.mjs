// Explicit live test: node tests/fast_mode_acceptance.mjs /absolute/evidence/directory [turn mode] [compaction mode]
// Uses the authenticated local openai-codex account. Never run as part of unit tests.
// Compares wire tiers with saved response and compaction labels.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [evidence, turnMode = "off", compactionMode] = process.argv.slice(2);
assert(evidence && path.isAbsolute(evidence), "Supply an absolute scratch evidence directory");
const modes = ["off", "fast", "ultrafast"];
assert(modes.includes(turnMode) && (compactionMode === undefined || modes.includes(compactionMode)), "Modes must be off, fast or ultrafast");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(evidence, "workspace-"));

// A private agent folder: the real login, our own speed settings, and nothing else of the user's.
const agentDir = fs.mkdtempSync(path.join(evidence, "agent-"));
fs.symlinkSync(path.join(process.env.HOME, ".pi/agent/auth.json"), path.join(agentDir, "auth.json"));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
fs.writeFileSync(path.join(agentDir, "fast-mode.json"), JSON.stringify({ mode: turnMode, compaction: compactionMode }));
process.env.PI_CODING_AGENT_DIR = agentDir;

// Record every request body that reaches OpenAI, on either transport. The Codex transport re-sends
// the same body after a connection-limit error, so a phase can show one request more than expected.
const requests = [];
const seen = (transport, text) => {
	if (typeof text !== "string" || !text.includes('"model"')) return;
	const body = JSON.parse(text);
	requests.push({ at: new Date().toISOString(), transport, model: body.model, service_tier: body.service_tier, instructions: String(body.instructions ?? "").slice(0, 60) });
	fs.writeFileSync(path.join(evidence, "requests.json"), JSON.stringify(requests, null, 2), { mode: 0o600 });
};
const send = WebSocket.prototype.send;
WebSocket.prototype.send = function (data) { seen("websocket", data); return send.call(this, data); };
const fetch = globalThis.fetch;
globalThis.fetch = (url, init) => { seen("sse", init?.body); return fetch(url, init); };

const { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager } = await import("@earendil-works/pi-coding-agent");
initTheme("dark", false); // Pi's CLI initialises the theme in every mode; the extension's status line needs it.
const { fastMode } = await import("../extensions/fast-mode.ts");
const tiers = { off: undefined, fast: "priority", ultrafast: "ultrafast" };
const speeds = { off: "standard", fast: "fast", ultrafast: "ultrafast" };
const effectiveCompaction = modes[Math.max(modes.indexOf(compactionMode ?? "fast"), modes.indexOf(turnMode))];
const runtime = await ModelRuntime.create();
const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
assert(model, "Approved model must exist in registry");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, extensionFactories: [(pi) => fastMode(pi)] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, resourceLoader: loader, modelRuntime: runtime, model, thinkingLevel: "medium", sessionManager: SessionManager.create(cwd, path.join(evidence, "sessions")) });
await session.bindExtensions({ onError: (error) => { throw error; } });
assert.equal(session.model?.provider, "openai-codex");

const prompt = "Use bash to write READY to ready.txt in the current directory, then reply READY.";
await session.prompt(prompt);
assert.equal(fs.readFileSync(path.join(cwd, "ready.txt"), "utf8").trim(), "READY");
assert(session.messages.some((message) => message.role === "toolResult" && message.toolName === "bash" && !message.isError), "The model must execute bash");
const turnRequests = requests.length;
assert(turnRequests >= 1, "No turn request observed");
assert(requests.every((r) => r.service_tier === tiers[turnMode]), `Turn requests must carry ${tiers[turnMode]}: ${JSON.stringify(requests)}`);

const result = await session.compact();
const compactionRequests = requests.slice(turnRequests);
assert(compactionRequests.length >= 1, "No compaction request observed");
assert(compactionRequests.every((r) => r.service_tier === tiers[effectiveCompaction]), `Compaction requests must carry ${tiers[effectiveCompaction]}: ${JSON.stringify(compactionRequests)}`);
assert(compactionRequests.every((r) => r.model === "gpt-6.1-sol"), "Compaction must use the active model");
const entry = session.sessionManager.getBranch().findLast((e) => e.type === "compaction");
assert(entry && entry.summary === result.summary && entry.summary.length > 0, "Compaction entry must be persisted");

const saved = fs.readFileSync(session.sessionManager.getSessionFile(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const replies = saved.filter((e) => e.type === "message" && e.message.role === "assistant");
const replySpeeds = replies.map((e) => e.message.diagnostics?.filter((d) => d.type === "vibes.speed").map((d) => d.details.speed));
assert(replies.length >= 1 && replies.length <= turnRequests, "At most one saved response per turn request (Codex may re-send one)");
assert(replySpeeds.every((labels) => labels?.length === 1 && labels[0] === speeds[turnMode]), `Saved responses must be labelled ${speeds[turnMode]}: ${JSON.stringify(replySpeeds)}`);
const compactionLabels = saved.filter((e) => e.type === "custom" && e.customType === "vibes.speed");
assert.deepEqual(compactionLabels.map((e) => e.data), [{ targetId: entry.id, provider: "openai-codex", model: "gpt-6.1-sol", speed: speeds[effectiveCompaction] }]);
fs.copyFileSync(session.sessionManager.getSessionFile(), path.join(evidence, "session.jsonl"));

await session.dispose();
fs.rmSync(agentDir, { recursive: true, force: true });
fs.rmSync(cwd, { recursive: true, force: true });
console.log(JSON.stringify({ passed: true, revision, model: `${model.provider}/${model.id}`, thinking: "medium", turnMode, compaction: effectiveCompaction, prompt, tool: "bash", turnRequests, compactionRequests: compactionRequests.length, replySpeeds, compactionLabels: compactionLabels.map((e) => e.data), summaryChars: entry.summary.length, evidence }));
