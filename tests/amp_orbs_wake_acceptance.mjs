// Explicit live test: npx jiti tests/amp_orbs_wake_acceptance.mjs /absolute/evidence/directory
// Uses the authenticated local Pi/Amp accounts and launches three scratch medium-mode orbs, archived at the
// end. Never run as part of unit tests. It exercises busy-parent and model-outage notification cases:
// 1. Orbs finish while Pi is busy: Pi gets one combined update when it becomes idle, not one turn each.
// 2. Pi's own model is rate limited: orb updates hold instead of each starting a doomed turn.
// Phase 2 points the real Pi session at a local endpoint that always answers HTTP 429, so Pi's real
// retry loop and settle events run; every other model call uses openai-codex/gpt-6.1-sol. Ambient
// extensions stay loaded, including any that resume after errors, so the hold is measured from Pi's
// last failed turn. A second Amp client gives orb C new work during the outage so it finishes at a known time inside the hold.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir, createCodemodeExtension, createToolSearchExtension, createMcpExtension } from "@earendil-works/pi-coding-agent";
import ampOrbs from "../lib/amp-orbs/extension.ts";
import { openActor, ThreadConnection, waitFor } from "../lib/amp-orbs/connection.ts";

const evidence = process.argv[2];
assert(evidence && path.isAbsolute(evidence), "Supply an absolute scratch evidence directory");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(evidence, "workspace-"));
const events = [];
const record = (event) => { events.push({ at: Date.now(), ...event }); fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 }); };
const count = (type, since = 0) => events.filter((e) => e.type === type && e.at >= since).length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const holdMs = 180_000; // Long enough for the late orb to finish inside the hold.

const limited = [];
const stub = http.createServer((request, response) => {
	limited.push(Date.now()); record({ type: "stub_429", path: request.url });
	request.resume();
	response.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { type: "rate_limit_error", message: "429 rate limit: this request would exceed your account's rate limit" } }));
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));

const runtime = await ModelRuntime.create();
const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
assert(model, "Approved model must exist in registry");
record({ type: "model", provider: model.provider, model: model.id, thinking: "medium", revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--porcelain", "lib"], { encoding: "utf8" }).trim() });
const ambientSettings = SettingsManager.create(cwd, getAgentDir()).getSettings();
const settingsManager = SettingsManager.inMemory({
	...ambientSettings,
	extensions: [...(ambientSettings.extensions ?? []), "!**/amp-orbs.ts"],
	packages: (ambientSettings.packages ?? []).map((entry) => {
		const config = typeof entry === "string" ? { source: entry } : entry;
		return { ...config, extensions: [...(config.extensions ?? ["**/*"]), "-extensions/amp-orbs.ts"] };
	}),
});
record({ type: "retry_settings", retry: settingsManager.getRetrySettings() });
const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager, extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension(),
	(pi) => ampOrbs(pi, { holdMs: [holdMs], open: async (threadId, capability, signal) => {
		// Record each orb's state changes and reconnects as evidence.
		const opened = await openActor(threadId, capability, signal);
		record({ type: "actor_open", threadId, capability });
		opened.socket.addEventListener("close", () => record({ type: "actor_close", threadId }));
		opened.socket.addEventListener("message", (event) => {
			const text = String(event.data); if (!text.includes("agent_state")) return;
			for (const frame of [JSON.parse(text)].flat()) {
				const p = frame.params ?? frame;
				if ((frame.method ?? frame.type) === "agent_state") record({ type: "orb_state", threadId, state: p.state, messageId: p.messageId });
			}
		});
		return opened;
	} }),
	(pi) => {
		pi.registerProvider("ratelimited-stub", { baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, api: "openai-completions", apiKey: "stub",
			models: [{ id: "always-429", name: "Always 429", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }] });
		pi.on("before_agent_start", async (event) => record({ type: "before_agent_start", messageType: event.messageType, customType: event.message?.customType, prompt: event.prompt?.slice(0, 80) }));
		pi.on("agent_settled", async () => record({ type: "agent_settled" }));
	},
] });
await loader.reload();
const errors = loader.getExtensions().errors;
assert.equal(errors.length, 0, JSON.stringify(errors));
const { session } = await createAgentSession({ cwd, resourceLoader: loader, settingsManager, modelRuntime: runtime, model, thinkingLevel: "medium", sessionManager: SessionManager.create(cwd, path.join(evidence, "sessions")) });
await session.bindExtensions({ onError: (error) => record({ type: "extension_error", error: error.message }) });
const ids = [];
const peers = new Set();
session.subscribe((event) => {
	if (event.type === "tool_execution_start") record({ type: event.type, name: event.toolName, args: event.args });
	if (event.type === "tool_execution_end") {
		record({ type: event.type, name: event.toolName, isError: event.isError });
		if (event.toolName === "create_thread" && event.result?.details?.threadId) ids.push(event.result.details.threadId);
	}
	if (event.type === "message_end" && event.message.role === "custom" && event.message.customType === "amp-orb-update") record({ type: "orb_update", content: event.message.content, threads: event.message.details.threads?.map((t) => t.threadId) ?? [event.message.details.threadId], statuses: event.message.details.threads });
	if (event.type === "message_end" && event.message.role === "assistant") record({ type: "assistant", text: event.message.content.filter((b) => b.type === "text").map((b) => b.text).join(""), provider: event.message.provider, model: event.message.model, stopReason: event.message.stopReason });
});
const exportThread = (id) => JSON.parse(execFileSync("amp", ["threads", "export", id], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }));
const finished = (id, text) => {
	const thread = exportThread(id);
	const reply = thread.messages.findLast((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text.includes(text)));
	return reply && { state: thread.meta.lastKnownAgentState.state, model: reply.usage?.model, at: Date.parse(reply.usage?.timestamp ?? thread.meta.lastKnownAgentState.updatedAt) };
};

let failure;
try {
	// Phase 1: three orbs finish while Pi sleeps in a tool call.
	const orb = (name, body) => `"Isolated protocol test. Do not modify repositories or other threads. Do not archive yourself. ${body}"`;
	const prompt = `This is a live acceptance test of the Amp tools already loaded. Do not use subagents or local Amp model calls.
Call create_thread three times, one after another, each with mode medium and cwd ${cwd}:
1. title "Pi wake acceptance A", literal prompt ${orb("A", "Reply exactly DONE-A.")}
2. title "Pi wake acceptance B", literal prompt ${orb("B", "Reply exactly DONE-B.")}
3. title "Pi wake acceptance C", literal prompt ${orb("C", "Reply exactly READY-C. Later messages will tell you what to reply next.")}
Then run the bash command \`sleep 150\` with a 200 second timeout. Do not call get_thread_status, wait_for_threads or any other Amp tool in this turn. After the sleep, end the turn with WAITING.
Later, when an Amp orb update arrives, do not call any tools: reply UPDATE RECEIVED followed by the thread IDs and replies it reports.`;
	fs.writeFileSync(path.join(evidence, "prompt.txt"), prompt);
	await session.prompt(prompt);
	// prompt() resolves only after any wake-up turn that Pi started as it settled, so measure from the
	// end of the busy turn itself.
	const busyEnd = events.find((e) => e.type === "assistant" && /WAITING/.test(e.text))?.at;
	assert(busyEnd, "the busy turn ended with WAITING");
	assert.equal(ids.length, 3, "three orbs launched");
	const [a, b, c] = ids;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline && !events.some((e) => e.type === "assistant" && e.at > busyEnd && /UPDATE RECEIVED/.test(e.text))) await sleep(500);
	await session.waitForIdle();
	const doneA = finished(a, "DONE-A"); const doneB = finished(b, "DONE-B"); const readyC = finished(c, "READY-C");
	assert(doneA && doneB && readyC, "all three orbs replied, checked independently in Amp's export");
	assert([doneA, doneB, readyC].every((reply) => reply.model === "gpt-6.1-sol"), "the scratch orbs must use the configured approved model");
	record({ type: "independent_amp_export", a: doneA, b: doneB, c: readyC, busyEnd });
	assert(Math.max(doneA.at, doneB.at, readyC.at) < busyEnd - 20_000, "all three finished while Pi was still busy, so this exercised the busy-parent path");
	const updates = events.filter((e) => e.type === "orb_update");
	assert.equal(updates.length, 1, "one combined update for the whole phase, not one queued turn per orb");
	assert(updates[0].at >= busyEnd, "sent only once Pi finished its turn");
	assert.deepEqual([...updates[0].threads].sort(), [a, b, c].sort());
	assert.equal(events.filter((e) => e.type === "before_agent_start" && e.customType === "amp-orb-update").length, 1, "one wake-up turn");
	record({ type: "phase1_passed" });

	// Simulate the persisted acknowledgement from the released, pre-episode checkpoint format.
	// The actual model has already received this actual Amp reply; an upgrade must stay quiet.
	const seenA = updates[0].statuses.find((status) => status.threadId === a);
	assert(seenA?.messageId && seenA.response.includes("DONE-A"));
	const legacyKey = createHash("sha256").update(JSON.stringify(["idle", seenA.messageId, seenA.messageId, seenA.response])).digest("hex");
	const checkpoint = structuredClone(session.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "amp-orbs-tracking").data);
	const legacyA = checkpoint.find((item) => item.threadId === a);
	delete legacyA.episode; delete legacyA.userMessageId; legacyA.notificationKeys = [legacyKey];
	session.sessionManager.appendCustomEntry("amp-orbs-tracking", checkpoint);
	const beforeUpgrade = count("orb_update");
	await session.reload(); await sleep(25_000); await session.waitForIdle();
	assert.equal(count("orb_update"), beforeUpgrade, "upgrading a legacy seen checkpoint does not repeat its old reply");
	record({ type: "legacy_upgrade_passed" });

	// Phase 2: Pi's model is rate limited. The user's message fails after Pi's own retries.
	const limitedModel = session.modelRuntime.getModel("ratelimited-stub", "always-429");
	assert(limitedModel, "stub model registered");
	await session.setModel(limitedModel);
	const failedAt = Date.now(); record({ type: "phase2_start" });
	await session.prompt("Reply OK.").catch((error) => record({ type: "prompt_error", message: error.message }));
	const attemptsPerTurn = limited.length;
	assert(attemptsPerTurn >= 1);
	assert.equal(events.findLast((e) => e.type === "assistant").stopReason, "error", "the user turn failed");
	record({ type: "user_turn_failed", attemptsPerTurn });
	// Someone else gives orb C new work through a separate Amp connection.
	const other = new ThreadConnection(c);
	peers.add(other);
	await other.send("Reply exactly LATE-C.", { sessionId: `${session.sessionManager.getSessionId()}:outside`, opening: false });
	record({ type: "external_message_sent", threadId: c });
	// Reload after the new reply arrives but before its hold expires. The real session must
	// restore its original deadline, not release the result or start a fresh hold.
	const late = await waitFor([other], () => other.state.status.state === "idle" && other.state.status.response.includes("LATE-C"), undefined, 60_000);
	assert(late, "C replied during the hold, before reload");
	other.stop(); peers.delete(other);
	const originalFailure = events.findLast((event) => event.type === "agent_settled").at;
	// agent-default (not a user rule): 2026-10-28. Separate original and restarted deadlines.
	await sleep(Math.max(0, originalFailure + holdMs / 2 - Date.now()));
	const beforeReload = count("orb_update", failedAt);
	assert.equal(beforeReload, 0, "the reply is still held before reload");
	await session.reload();
	assert.equal(session.model?.id, "always-429", "reload preserves the failed model selection");
	record({ type: "reload_during_hold" });
	await sleep(2000);
	assert.equal(count("orb_update", failedAt), beforeReload, "reload must not bypass the hold");
	// Wait for the held update's single wake attempt and for Pi to settle after it.
	const wakeDeadline = Date.now() + holdMs + 180_000;
	const wakeTurn = () => events.find((e) => e.type === "before_agent_start" && e.customType === "amp-orb-update" && e.at >= failedAt);
	while (Date.now() < wakeDeadline && !(wakeTurn() && events.some((e) => e.type === "agent_settled" && e.at > wakeTurn().at))) await sleep(2000);
	await sleep(30_000); // Anything that reacts to the failed wake turn would start within this time.
	await session.waitForIdle();
	const wake = wakeTurn();
	assert(wake, "the held update was eventually sent");
	const doneC = finished(c, "LATE-C");
	assert(doneC, "orb C replied LATE-C, checked independently in Amp's export");
	record({ type: "independent_amp_export", c: doneC });
	const lastFailure = events.filter((e) => e.type === "agent_settled" && e.at < wake.at).at(-1).at;
	assert(doneC.at > failedAt && doneC.at < lastFailure + holdMs - 60_000, "C finished during the outage, well inside the hold");
	assert(wake.at >= lastFailure + holdMs - 1000, "the update waited for the hold to end after Pi's last failed turn");
	// agent-default (not a user rule): 2026-10-28. Scheduling margin smaller than the reload offset.
	assert(wake.at <= originalFailure + holdMs * 1.25, "reload kept the original deadline rather than starting a fresh hold");
	assert(wake.at - doneC.at > 60_000, "rather than going out a quiet period after C finished");
	assert.equal(events.filter((e) => e.type === "before_agent_start" && e.customType === "amp-orb-update" && e.at >= failedAt).length, 1, "exactly one wake attempt during the outage");
	assert.deepEqual(events.filter((e) => e.type === "orb_update" && e.at >= failedAt).map((e) => e.threads), [[c]]);
	const wakeEnd = events.find((e) => e.type === "agent_settled" && e.at > wake.at).at;
	assert.equal(limited.filter((at) => at >= wake.at && at <= wakeEnd).length, attemptsPerTurn, "the wake turn cost one turn of Pi's retries");
	const resumes = events.filter((e) => e.type === "before_agent_start" && e.messageType === "user" && e.at > failedAt + 1000);
	assert.equal(limited.length, attemptsPerTurn * (2 + resumes.length), "every stub request belongs to the user turn, an ambient resume or the one wake turn");
	record({ type: "phase2_passed", stubRequests: limited.length, ambientResumes: resumes.map((e) => e.prompt) });

	// Phase 3: the model works again. The held update is in the transcript, and the user's next message succeeds.
	await session.setModel(model);
	const recoveredAt = Date.now();
	await session.prompt(`The scratch test is ending. Without calling any tools, reply with the exact final reply of thread ${c} as reported in the orb updates above.`);
	await session.waitForIdle();
	const reply = events.findLast((e) => e.type === "assistant");
	assert.equal(reply.stopReason, "stop"); assert.match(reply.text, /LATE-C/, "the update delivered during the outage reached the model");
	await sleep(2000);
	assert.equal(events.filter((e) => e.type === "before_agent_start" && e.customType === "amp-orb-update" && e.at >= recoveredAt).length, 0, "nothing else was waiting");
	assert(events.filter((e) => e.type === "assistant" && e.provider !== "ratelimited-stub").every((e) => e.provider === "openai-codex" && e.model === "gpt-6.1-sol"), "every real model call used the approved model");
	record({ type: "phase3_passed" });

	// Phase 4: observe new work, reload before its completion, and receive exactly one new result.
	const workAt = Date.now();
	const writer = new ThreadConnection(c);
	peers.add(writer);
	await writer.send("Run the shell command sleep 30, then reply exactly RELOADED-C. Do not change any files.", { sessionId: `${session.sessionManager.getSessionId()}:outside`, opening: false });
	const active = () => events.some((e) => e.type === "orb_state" && e.threadId === c && e.at >= workAt && !["idle", "error", "unknown"].includes(e.state));
	const workDeadline = Date.now() + 60_000;
	while (Date.now() < workDeadline && !active()) await sleep(100);
	assert(active(), "the observer saw the new work before reload");
	const beforeNewWork = count("orb_update", workAt);
	assert.equal(beforeNewWork, 0, "new work has not reported before reload");
	let restoredAt;
	await session.reload({ beforeSessionStart: async () => {
		// Keep the observer closed until the work finishes. Restoring first into working can
		// advance a stale episode on its own and would fail to exercise checkpoint persistence.
		// agent-default (not a user rule): 2026-10-28. Bound the synthetic remote sleep and reply.
		const done = await waitFor([writer], () => writer.state.status.state === "idle" && writer.state.status.response.includes("RELOADED-C"), undefined, 90_000);
		assert(done, "the outside work completed while the observer was closed");
		const completed = structuredClone(writer.state.status);
		writer.stop(); peers.delete(writer);
		restoredAt = Date.now(); record({ type: "completed_while_observer_closed", reply: completed });
	} });
	record({ type: "reload_during_work" });
	const completionDeadline = Date.now() + 180_000;
	while (Date.now() < completionDeadline && !events.some((e) => e.type === "assistant" && e.at >= workAt && e.text.includes("RELOADED-C"))) await sleep(500);
	await session.waitForIdle();
	assert.equal(events.find((event) => event.type === "orb_state" && event.threadId === c && event.at >= restoredAt)?.state, "idle", "the first restored state was idle, not a new working transition");
	assert.equal(count("orb_update", workAt), beforeNewWork + 1, "a completion after reload wakes Pi exactly once");
	assert(finished(c, "RELOADED-C"), "the post-reload completion exists independently in Amp");
	assert(events.some((e) => e.type === "assistant" && e.at >= workAt && e.text.includes("RELOADED-C")), "the real model received the post-reload completion");
	await session.reload(); await sleep(25_000); await session.waitForIdle();
	assert.equal(count("orb_update", workAt), beforeNewWork + 1, "a second reload does not repeat the delivered result");
	assert(events.filter((e) => e.type === "assistant" && e.provider !== "ratelimited-stub").every((e) => e.provider === "openai-codex" && e.model === "gpt-6.1-sol"), "reload preserved the approved model for every real call");
	record({ type: "phase4_passed" });

	// Phase 5: the entire new task, including its input, occurs with the main observer closed.
	const offlineAt = Date.now();
	const offlineWriter = new ThreadConnection(c); peers.add(offlineWriter);
	let offlineRestoredAt;
	const savedC = () => session.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "amp-orbs-tracking").data.find((item) => item.threadId === c);
	await session.reload({ beforeSessionStart: async () => {
		const before = structuredClone(savedC());
		assert(before.userMessageId, "the observed task input was checkpointed");
		await offlineWriter.send("Reply exactly OFFLINE-C. Do not change any files.", { sessionId: `${session.sessionManager.getSessionId()}:outside`, opening: false });
		const done = await waitFor([offlineWriter], () => offlineWriter.state.status.state === "idle" && offlineWriter.state.status.response.includes("OFFLINE-C"), undefined, 90_000);
		assert(done, "the new task started and completed while the main observer was closed");
		assert.deepEqual(savedC(), before, "no working transition or input was observed/checkpointed by the closed observer");
		offlineWriter.stop(); peers.delete(offlineWriter);
		offlineRestoredAt = Date.now();
	} });
	const offlineDeadline = Date.now() + 120_000;
	while (Date.now() < offlineDeadline && !events.some((e) => e.type === "assistant" && e.at >= offlineAt && e.text.includes("OFFLINE-C"))) await sleep(500);
	await session.waitForIdle();
	assert.equal(events.find((e) => e.type === "orb_state" && e.threadId === c && e.at >= offlineRestoredAt)?.state, "idle");
	assert.equal(count("orb_update", offlineAt), 1, "new offline input wakes the parent exactly once");
	assert(events.some((e) => e.type === "assistant" && e.at >= offlineAt && e.text.includes("OFFLINE-C")), "the real model received the task completed wholly offline");
	await session.reload(); await sleep(25_000); await session.waitForIdle();
	assert.equal(count("orb_update", offlineAt), 1, "full history does not repeat the offline completion");
	record({ type: "phase5_passed" });
} catch (error) { failure = error; record({ type: "failure", message: error.message }); }
finally {
	for (const peer of peers) peer.stop();
	await session.abort(); session.dispose(); stub.close();
	for (const id of ids) { execFileSync("amp", ["threads", "archive", id], { stdio: "pipe" }); record({ type: "archived_scratch", threadId: id }); }
}
if (failure) { console.error(failure.message); process.exit(1); }
console.log(JSON.stringify({ passed: true, evidence, threads: ids, stubRequests: limited.length }));
process.exit(0);
