// Explicit live test: npx jiti tests/amp_orbs_acceptance.mjs /absolute/evidence/directory
// Uses the authenticated local Pi/Amp accounts. Never run as part of unit tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir, createCodemodeExtension, createToolSearchExtension, createMcpExtension } from "@earendil-works/pi-coding-agent";
import ampOrbs from "../lib/amp-orbs/extension.ts";
import { openActor } from "../lib/amp-orbs/connection.ts";

const evidence = process.argv[2];
assert(evidence && path.isAbsolute(evidence), "Supply an absolute scratch evidence directory");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(evidence, "workspace-"));
const events = [];
const record = (event) => { events.push({ at: new Date().toISOString(), ...event }); fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 }); };
const runtime = await ModelRuntime.create();
const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
assert(model, "Approved model must exist in registry");
record({ type: "model", provider: model.provider, model: model.id, thinking: "medium", revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() });
let session;
const sockets = new Map();
const observedAmpOrbs = (pi) => ampOrbs(pi, {
	open: async (threadId, capability, signal) => {
		const opened = await openActor(threadId, capability, signal);
		sockets.set(threadId, opened.socket);
		record({ type: "actor_open", threadId, capability, version: opened.version });
		opened.socket.addEventListener("message", (event) => {
			if (String(event.data).startsWith('{"jsonrpc":"2.0","id":1,"result"')) record({ type: "actor_synchronized", threadId });
		});
		return opened;
	},
});
const ambientSettings = SettingsManager.create(cwd, getAgentDir()).getSettings();
const settingsManager = SettingsManager.inMemory({
	...ambientSettings,
	extensions: [...(ambientSettings.extensions ?? []), "!**/amp-orbs.ts"],
	packages: (ambientSettings.packages ?? []).map((entry) => {
		const config = typeof entry === "string" ? { source: entry } : entry;
		return { ...config, extensions: [...(config.extensions ?? ["**/*"]), "-extensions/amp-orbs.ts"] };
	}),
});
const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager, extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension(), observedAmpOrbs,
	(pi) => {
		pi.on("before_agent_start", async (event) => record({ type: "before_agent_start", messageType: event.messageType, customType: event.message?.customType }));
		pi.on("agent_start", async () => record({ type: "agent_start" }));
		pi.on("agent_settled", async () => record({ type: "agent_settled" }));
	},
] });
await loader.reload();
const errors = loader.getExtensions().errors;
assert.equal(errors.length, 0, JSON.stringify(errors));
({ session } = await createAgentSession({ cwd, resourceLoader: loader, settingsManager, modelRuntime: runtime, model, thinkingLevel: "medium", sessionManager: SessionManager.create(cwd, path.join(evidence, "sessions")) }));
await session.bindExtensions({ onError: (error) => record({ type: "extension_error", error: error.message }) });
record({ type: "tools", names: session.getActiveToolNames() });
const ids = new Set();
session.subscribe((event) => {
	if (event.type === "tool_execution_start") record({ type: event.type, name: event.toolName, args: event.args });
	if (event.type === "tool_execution_end") {
		record({ type: event.type, name: event.toolName, result: event.result, isError: event.isError });
		if (event.toolName === "create_thread" && event.result?.details?.threadId) ids.add(event.result.details.threadId);
	}
	if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "amp-orb-update") record({ type: "orb_update", content: event.message.content, details: event.message.details });
	if (event.type === "message_end" && event.message.role === "assistant") record({ type: "assistant", content: event.message.content, provider: event.message.provider, model: event.message.model, thinking: event.message.thinkingLevel });
});
const prompt = `This is a live acceptance test of the four Amp tools already loaded. Do not use subagents or local Amp model calls. Use create_thread exactly once to launch a scratch low-mode orb, cwd ${cwd}, title Pi Amp tools acceptance. Literal orb prompt: "This is an isolated protocol acceptance test. Do not modify repositories or other threads. First use Bash to sleep 25 seconds. Then use ask_user_choice to ask Choose Red or Blue, with options Red and Blue. Wait for the answer, then reply exactly RECEIVED Blue if Blue is answered. Do not archive yourself." After create_thread returns, end your initial turn immediately with LAUNCHED and the thread ID. Do not wait or poll in that initial turn. The background observer should wake you. When its question update arrives, call get_thread_status, verify the pending question, call send_thread_message with Blue, then wait_for_threads (timeout_seconds 120), and get_thread_status to confirm RECEIVED Blue and idle. End with ACCEPTANCE PASSED only once confirmed. If a later duplicate update arrives after success, just acknowledge; do not create or send again. Do not change any personal settings or call any other delegation tool.`;
fs.writeFileSync(path.join(evidence, "prompt.txt"), prompt);
let failure;
try {
	await session.prompt(prompt);
	record({ type: "initial_prompt_resolved", streaming: session.isStreaming });
	assert.equal(ids.size, 1, "create_thread did not return an ID");
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline && !events.some((e) => e.type === "assistant" && e.content?.some((b) => b.type === "text" && b.text.includes("ACCEPTANCE PASSED")))) await new Promise((r) => setTimeout(r, 250));
	assert(events.some((e) => e.type === "assistant" && e.content?.some((b) => b.type === "text" && b.text.includes("ACCEPTANCE PASSED"))), "Agent did not confirm acceptance");
	await session.waitForIdle();
	for (const name of ["create_thread", "get_thread_status", "send_thread_message", "wait_for_threads"]) assert(events.some((e) => e.type === "tool_execution_start" && e.name === name), `${name} not called`);
	assert(events.some((e) => e.type === "initial_prompt_resolved" && !e.streaming), "Initial Pi turn did not become idle");
	const idleAt = events.findIndex((e) => e.type === "initial_prompt_resolved");
	assert(events.slice(idleAt).some((e) => e.type === "before_agent_start" && e.messageType === "custom" && e.customType === "amp-orb-update"), "No idle background wake");
	assert.equal(ids.size, 1);
	const calls = events.filter((e) => e.type === "tool_execution_start");
	assert.equal(calls.filter((e) => e.name === "create_thread").length, 1, "Exactly one launch, no retries");
	assert(calls.every((e) => ["read", "create_thread", "get_thread_status", "send_thread_message", "wait_for_threads", "stop_tracking_thread"].includes(e.name)), "Unexpected tool path; inspect for intermediaries (normal skill reads are expected)");
	assert(events.filter((e) => e.type === "assistant").every((e) => e.provider === "openai-codex" && e.model === "gpt-6.1-sol"), "Actual model differs from approved model");
	for (const id of ids) {
		const count = (type) => events.filter((e) => e.type === type).length;
		const [opensBefore, syncsBefore, updatesBefore, turnsBefore] = [count("actor_open"), count("actor_synchronized"), count("orb_update"), count("before_agent_start")];
		sockets.get(id).close();
		const reconnectDeadline = Date.now() + 35000;
		while (Date.now() < reconnectDeadline && count("actor_synchronized") === syncsBefore) await new Promise((r) => setTimeout(r, 50));
		assert(count("actor_open") > opensBefore, "No fresh authorization/open");
		assert(count("actor_synchronized") > syncsBefore, "Real observer did not resynchronize");
		await new Promise((r) => setTimeout(r, 2000));
		await session.waitForIdle();
		assert.equal(count("orb_update"), updatesBefore, "Transport change or replay triggered an update");
		assert.equal(count("before_agent_start"), turnsBefore, "Reconnect woke the model without new work");
		record({ type: "real_reconnect", threadId: id, connected: true, dedupedCompletion: true });
		const raw = execFileSync("amp", ["threads", "export", id], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
		fs.writeFileSync(path.join(evidence, `${id}.json`), raw, { mode: 0o600 });
		const thread = JSON.parse(raw);
		assert.equal(thread.meta.lastKnownAgentState.state, "idle");
		assert(thread.messages.some((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text.includes("RECEIVED Blue"))));
		record({ type: "independent_amp_export", threadId: id, state: thread.meta.lastKnownAgentState.state, verifiedReply: "RECEIVED Blue" });
		await session.prompt(`The scratch thread ${id} is independently verified complete. Call stop_tracking_thread for that exact ID, then reply DETACHED. Do not archive or cancel remote work.`);
		await session.waitForIdle();
		assert(events.some((e) => e.type === "tool_execution_start" && e.name === "stop_tracking_thread" && e.args.threadId === id), "Model did not call the actual unwatch tool");
		assert(sockets.get(id).readyState >= 2, "Local observer socket is still open after unwatch");
		record({ type: "independent_unwatch", threadId: id, socketReadyState: sockets.get(id).readyState });
	}
} catch (error) { failure = error; record({ type: "failure", message: error.message }); }
finally {
	await session.abort(); session.dispose();
	for (const id of ids) { execFileSync("amp", ["threads", "archive", id], { stdio: "pipe" }); record({ type: "archived_scratch", threadId: id }); }
}
if (failure) { console.error(failure.message); process.exit(1); }
console.log(JSON.stringify({ passed: true, evidence, threads: [...ids] }));
process.exit(0);
