import assert from "node:assert/strict";
import { test } from "node:test";
import ampOrbs from "../lib/amp-orbs/extension.ts";

const id = "T-00000000-0000-0000-0000-000000000001";
const question = (requestId, status = "pending") => ({ requestId, status, method: "ui.select" });
const plugin = (name, request) => ({ jsonrpc: "2.0", method: "plugin_message", params: { message: { event: `plugin.ui.${name}`, data: { request } } } });
const agentState = (state, messageId) => ({ jsonrpc: "2.0", method: "agent_state", params: { state, messageId } });
let snapshot = [{ type: "agent_state", state: "running_tools", messageId: "m1" }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [] } } }];
let acceptMessages = true;

const sockets = [];
class FakeSocket extends EventTarget {
	sent = []; closed = false;
	constructor(capability) { super(); this.capability = capability; setTimeout(() => this.dispatchEvent(new Event("open"))); }
	send(text) {
		const frame = JSON.parse(text); this.sent.push(frame);
		queueMicrotask(() => {
			if (frame.id === 1) {
				// Amp skips stored messages when resuming from the current authorization version.
				const replay = frame.params.version === 0 ? snapshot : snapshot.filter((event) => event.type !== "message_added");
				this.receive(replay); this.receive({ id: 1, result: {} });
			}
			else this.receive(acceptMessages ? { id: frame.id, result: { ok: true } } : { id: frame.id, error: { message: "denied" } });
		});
	}
	receive(frame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
	close() { this.closed = true; }
}
const open = async (_id, capability) => { const socket = new FakeSocket(capability); sockets.push(socket); return { socket, version: 1 }; };

const tools = new Map(); const handlers = new Map(); const entries = []; const messages = [];
const pi = {
	registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); },
	appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
	sendMessage(message, options) { messages.push({ message, options }); },
};
const statuses = [];
const ui = { setStatus: (key, value) => statuses.push({ key, value }) };
const sessionId = "01a182cf-a771-70ae-a278-bf133e8dca4e";
const ctx = { ui, isIdle: () => true, sessionManager: { getBranch: () => entries, getSessionId: () => sessionId } };
const call = async (name, args, signal) => JSON.parse((await tools.get(name).execute("call", args, signal, undefined, ctx)).content[0].text);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const waitUntil = async (predicate) => {
	// agent-default (not a user rule): 2026-10-28. Bound fixture readiness, not notification latency.
	const deadline = Date.now() + 5000;
	while (!predicate() && Date.now() < deadline) await tick();
	assert(predicate(), "the asynchronous fixture did not become ready");
};
const launches = [];
ampOrbs(pi, { launch: async (options) => { launches.push(options); return id; }, open, quietMs: 0 });

await handlers.get("session_start")({}, ctx);
assert.equal(sockets.length, 0, "an empty session opens no sockets");
await call("create_thread", { prompt: "literal", cwd: "/tmp", mode: "low", title: "Task" });
assert.deepEqual(launches, [{ cwd: "/tmp", mode: "low", title: "Task", sessionId }], "the launch carries the session, not the prompt");
const orb = sockets.at(-1);
const { content: [task, note], meta } = orb.sent.at(-1).params;
assert.equal(task.text, "literal", "the prompt is sent literally");
assert.equal(meta.generatedByPlugin, "Pi 3e8dca4e", "Amp labels the task as from this Pi session");
assert(note.hidden && note.text.includes(`Pi session \`${sessionId}\``) && !note.text.includes("Start acting"), "a hidden note names the Pi session; only follow-ups say to start acting");
assert.equal(entries.at(-1).data[0].threadId, id, "launched threads are persisted");
await tick();
assert.equal(messages.length, 0, "launching does not wake Pi");
snapshot = [{ type: "agent_state", state: "tool_use", messageId: "m1" }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [question("q1")] } } }];
orb.receive(plugin("request_added", question("q1")));
await waitUntil(() => messages.length > 0);
assert.equal(messages.length, 1, "a pending question wakes Pi");
assert.equal(messages[0].options.triggerTurn, true);
orb.receive(plugin("request_added", question("q1"))); await tick();
assert.equal(messages.length, 1, "the same question does not wake twice");
assert.equal((await call("get_thread_status", { threadId: id })).questions[0].requestId, "q1");

orb.dispatchEvent(new Event("close")); await tick();
assert.equal(messages.length, 1, "a lost connection does not wake Pi");
assert.match(statuses.at(-1).value, /disconnected/, "a lost connection is visible in status");
const status = await call("get_thread_status", { threadId: id });
assert.equal(status.connection, "connected", "reading status reconnects with a fresh authorization");
assert.equal(sockets.length, 3); assert.equal(messages.length, 1, "the replayed question does not wake again");

acceptMessages = false;
await assert.rejects(call("send_thread_message", { threadId: id, message: "Red" }), /rejected/);
assert.deepEqual(sockets.map((s) => s.capability), ["read", "write", "write", "write"], "a rejection rereads the snapshot");
await tick();
assert.equal((await call("get_thread_status", { threadId: id })).settled, true, "after a rejection the open question still counts");

acceptMessages = true;
assert.equal((await call("send_thread_message", { threadId: id, message: "Blue" })).accepted, true);
const sent = sockets.at(-1).sent.at(-1);
assert.equal(sent.method, "client_append_user_msg"); assert.equal(sent.params.content[0].text, "Blue"); assert.equal(sent.params.steer, true);
assert.equal(sent.params.meta.generatedByPlugin, "Pi 3e8dca4e", "follow-ups are labelled as from this Pi session");
assert(sent.params.content[1].hidden && sent.params.content[1].text.includes("Start acting on it without first replying to it in text."));
assert.equal((await call("wait_for_threads", { threads: [id], timeout_seconds: 0.01 })).timedOut, true, "the answered question no longer settles the thread");
const beforeWait = messages.length;
const waiting = call("wait_for_threads", { threads: [id], timeout_seconds: 5 });
sockets.at(-1).receive(plugin("request_settled", question("q1", "done")));
sockets.at(-1).receive(agentState("working", "m2"));
sockets.at(-1).receive({ jsonrpc: "2.0", method: "delta", params: { role: "assistant", messageId: "m3", blocks: [{ type: "text", text: "RECEIVED Blue" }] } });
sockets.at(-1).receive(agentState("idle", "m3"));
const waited = await waiting;
assert.equal(waited.timedOut, false); assert.equal(waited.threads[0].response, "RECEIVED Blue");
await tick();
assert.equal(messages.length, beforeWait, "work Pi already read in a wait result does not wake it again");
sockets.at(-1).receive(agentState("working", "m4"));
sockets.at(-1).receive({ jsonrpc: "2.0", method: "delta", params: { role: "assistant", messageId: "m5", blocks: [{ type: "text", text: "FOLLOW-UP DONE" }] } });
sockets.at(-1).receive(agentState("idle", "m5")); await tick();
assert.equal(messages.length, beforeWait + 1);
assert.match(messages.at(-1).message.content, /FOLLOW-UP DONE/, "work the orb finished on its own wakes Pi");
assert.match(messages.at(-1).message.content, /Amp orb stopped/);
assert(!messages.at(-1).message.content.includes('"connection"'), "updates are readable prose, not serialized status");
const controller = new AbortController();
sockets.at(-1).receive(agentState("working", "m6"));
const cancelled = call("wait_for_threads", { threads: [id] }, controller.signal); controller.abort();
await assert.rejects(cancelled, /remote work continues/);

const woken = messages.length;
await handlers.get("session_shutdown")({}, ctx);
assert(sockets.at(-1).closed, "shutdown closes the transport");
sockets.at(-1).receive(agentState("idle", "m7")); await tick();
assert.equal(messages.length, woken, "a closed session is never woken");

// Restore the actual state at shutdown: m6 was working after the reported m5 completion.
snapshot = [{ type: "agent_state", state: "working", messageId: "m6" }, { type: "message_added", message: { role: "assistant", messageId: "m5", content: [{ type: "text", text: "FOLLOW-UP DONE" }] } }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [] } } }];
await handlers.get("session_start")({}, ctx); await tick();
assert.equal(sockets.at(-1).capability, "read", "reload resumes tracking");
assert.equal(messages.length, woken, "reload does not repeat delivered notifications");
sockets.at(-1).receive(plugin("request_added", question("q2"))); await tick();
assert.equal(messages.length, woken + 1, "new questions after reload still wake Pi");

const updatesBeforeStop = messages.length;
assert.deepEqual(await call("stop_tracking_thread", { threadId: id }), { threadId: id, wasTracked: true });
assert(sockets.at(-1).closed, "stop tracking closes the local observer");
assert.deepEqual(entries.at(-1).data, [], "stopping is persisted");
assert.equal(statuses.at(-1).value, undefined, "no watched threads clears status");
sockets.at(-1).receive(agentState("idle", "after-stop")); await tick();
assert.equal(messages.length, updatesBeforeStop, "stopped observers cannot wake Pi");
const socketsBeforeRestore = sockets.length;
await handlers.get("session_start")({}, ctx);
assert.equal(sockets.length, socketsBeforeRestore, "reload does not restore an unwatched thread");
assert.deepEqual(await call("stop_tracking_thread", { threadId: id }), { threadId: id, wasTracked: false });
await call("get_thread_status", { threadId: id });
assert.equal(sockets.length, socketsBeforeRestore + 1, "explicit status read can resume tracking");
assert.equal(sockets.at(-1).sent[0].method, "client_resume", "unwatch never sends a remote mutation");

await handlers.get("session_tree")({}, { ui, sessionManager: { getBranch: () => [], getSessionId: () => sessionId } });
assert(sockets.at(-1).closed, "moving to a branch without tracking stops observers");
// A brief Amp server error while reconnecting is retried quietly.
{
	const flakyId = "T-00000000-0000-0000-0000-000000000003";
	const tools3 = new Map(); const handlers3 = new Map(); const entries3 = []; const messages3 = [];
	let serverErrors = 1; const opened = [];
	const open3 = async (threadId, capability) => {
		opened.push(threadId);
		if (opened.length > 2 && serverErrors-- > 0) throw new Error("Amp actor authorization failed (HTTP 500)");
		return open(threadId, capability);
	};
	const pi3 = {
		registerTool(tool) { tools3.set(tool.name, tool); }, on(name, handler) { handlers3.set(name, handler); },
		appendEntry(customType, data) { entries3.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage(message, options) { messages3.push({ message, options }); },
	};
	const ctx3 = { ui: { setStatus() {} }, isIdle: () => true, sessionManager: { getBranch: () => entries3, getSessionId: () => sessionId } };
	ampOrbs(pi3, { launch: async () => flakyId, open: open3, quietMs: 0 });
	await handlers3.get("session_start")({}, ctx3);
	snapshot = [{ type: "agent_state", state: "running_tools", messageId: "m1" }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [] } } }];
	await tools3.get("create_thread").execute("call", { prompt: "literal", cwd: "/tmp", mode: "low" }, undefined, undefined, ctx3); await tick();
	sockets.at(-1).dispatchEvent(new Event("close"));
	await new Promise((resolve) => setTimeout(resolve, 3600)); // the close, then one HTTP 500 (1 s, then 2 s backoff)
	assert.equal(opened.length, 4, "launch read and write, one failed reconnect, then a successful one");
	assert.equal(messages3.length, 0, "a brief server error does not wake Pi");
	const status = JSON.parse((await tools3.get("get_thread_status").execute("call", { threadId: flakyId }, undefined, undefined, ctx3)).content[0].text);
	assert.equal(status.connection, "connected", "the observer recovered on its own");
	await handlers3.get("session_shutdown")({}, ctx3);
}

// Archiving an orb ends tracking quietly: no failure alert, no reconnect loop, nothing restored on reload.
{
	const archivedId = "T-00000000-0000-0000-0000-000000000002";
	const tools2 = new Map(); const handlers2 = new Map(); const entries2 = []; const messages2 = []; const statuses2 = [];
	let archived = false; const opened = [];
	const open2 = async (threadId, capability) => {
		opened.push(threadId);
		if (archived) throw new Error("Amp thread is archived");
		return open(threadId, capability);
	};
	const pi2 = {
		registerTool(tool) { tools2.set(tool.name, tool); }, on(name, handler) { handlers2.set(name, handler); },
		appendEntry(customType, data) { entries2.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage(message, options) { messages2.push({ message, options }); },
	};
	const ctx2 = { ui: { setStatus: (key, value) => statuses2.push({ key, value }) }, isIdle: () => true, sessionManager: { getBranch: () => entries2, getSessionId: () => sessionId } };
	const call2 = async (name, args) => JSON.parse((await tools2.get(name).execute("call", args, undefined, undefined, ctx2)).content[0].text);
	ampOrbs(pi2, { launch: async () => archivedId, open: open2, quietMs: 0 });
	await handlers2.get("session_start")({}, ctx2);
	snapshot = [{ type: "agent_state", state: "running_tools", messageId: "m1" }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [] } } }];
	await call2("create_thread", { prompt: "literal", cwd: "/tmp", mode: "low" }); await tick();
	assert.equal(entries2.at(-1).data[0].threadId, archivedId);
	archived = true; sockets.at(-1).dispatchEvent(new Event("close"));
	await new Promise((resolve) => setTimeout(resolve, 1100)); // past the first reconnect backoff
	assert.equal(messages2.length, 0, "archiving a watched orb does not raise a failure alert");
	assert.deepEqual(entries2.at(-1).data, [], "an archived orb is no longer tracked");
	assert.equal(statuses2.at(-1).value, undefined, "status no longer counts the archived orb");
	const attempts = opened.length;
	await new Promise((resolve) => setTimeout(resolve, 2100));
	assert.equal(opened.length, attempts, "an archived orb is not reconnected");
	const status = await call2("get_thread_status", { threadId: archivedId });
	assert.equal(status.archived, true); assert.equal(status.settled, true); assert.equal(status.connectionError, "Amp thread is archived");
	assert.equal(opened.length, attempts + 1, "an explicit status read re-checks once");
	assert.deepEqual(entries2.at(-1).data, [], "re-checking an archived orb does not resume tracking");
	assert.equal((await call2("wait_for_threads", { threads: [archivedId], timeout_seconds: 5 })).timedOut, false, "an archived orb does not hold a wait");
	await assert.rejects(call2("send_thread_message", { threadId: archivedId, message: "hi" }), /archived/);
	assert.equal(messages2.length, 0);
	await handlers2.get("session_shutdown")({}, ctx2);
}

// The 21 October storm: while Pi worked, every orb update joined Pi's follow-up queue; once Pi's model
// hit a rate limit, each queued update started its own failing turn. Updates now wait in the
// extension, go out together when Pi is idle, skip what Pi already read, and hold after a model error.
{
	const ids = [4, 5, 6, 7].map((n) => `T-00000000-0000-0000-0000-00000000000${n}`);
	const [a, b, c, d] = ids;
	const tools4 = new Map(); const handlers4 = new Map(); const entries4 = []; const messages4 = [];
	const byThread = new Map();
	const open4 = async (threadId, capability) => { const opened = await open(threadId, capability); byThread.set(threadId, opened.socket); return opened; };
	let idle = false; let lastReply = { stopReason: "stop" };
	const pi4 = {
		registerTool(tool) { tools4.set(tool.name, tool); }, on(name, handler) { handlers4.set(name, handler); },
		appendEntry(customType, data) { entries4.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage(message, options) { messages4.push({ message, options }); },
	};
	const statuses4 = [];
	const ctx4 = { ui: { setStatus: (_key, value) => statuses4.push(value) }, isIdle: () => idle, sessionManager: { getSessionId: () => sessionId, getBranch: () => [...entries4, { type: "message", message: { role: "assistant", ...lastReply } }] } };
	const call4 = async (name, args) => JSON.parse((await tools4.get(name).execute("call", args, undefined, undefined, ctx4)).content[0].text);
	const settle = () => handlers4.get("agent_settled")({ aborted: false }, ctx4);
	const launches = [...ids];
	ampOrbs(pi4, { launch: async () => launches.shift(), open: open4, quietMs: 0, holdMs: [150] });
	await handlers4.get("session_start")({}, ctx4);
	snapshot = [{ type: "agent_state", state: "running_tools", messageId: "m1" }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [] } } }];
	for (const _ of ids) await call4("create_thread", { prompt: "literal", cwd: "/tmp", mode: "low" });
	await tick();
	const delta = (messageId, state, text = "x") => ({ jsonrpc: "2.0", method: "delta", params: { role: "assistant", messageId, blocks: [{ type: "text", text }], contentMode: "snapshot", state } });

	// Pi is busy (say, in a long tool call). A retries failed replies, then asks a question; B finishes;
	// C finishes but Pi stops watching it; D stops with a failure that a wait then returns.
	for (let i = 2; i < 12; i++) { byThread.get(a).receive(agentState("streaming", `m${i}`)); byThread.get(a).receive(delta(`m${i}`, "error")); }
	byThread.get(a).receive(plugin("request_added", question("qa")));
	byThread.get(b).receive(delta("m2", "complete", "B DONE")); byThread.get(b).receive(agentState("idle", "m2"));
	byThread.get(c).receive(delta("m2", "complete", "C DONE")); byThread.get(c).receive(agentState("idle", "m2"));
	byThread.get(d).receive(delta("m2", "error")); byThread.get(d).receive(agentState("error", "m2"));
	await tick();
	assert.equal(messages4.length, 0, "nothing is queued into Pi while it works");
	assert.equal((await call4("wait_for_threads", { threads: [d], timeout_seconds: 1 })).threads[0].error, "Amp assistant message failed");
	await call4("stop_tracking_thread", { threadId: c });

	idle = true; await settle();
	assert.equal(messages4.length, 1, "one combined update when Pi becomes idle");
	const sent = messages4[0];
	assert.equal(sent.options.triggerTurn, true);
	assert.match(sent.message.content, /2 Amp orb updates/);
	assert.match(sent.message.content, new RegExp(`needs input: https://ampcode.com/threads/${a}`));
	assert.match(sent.message.content, /B DONE/);
	assert(!sent.message.content.includes(c), "a thread Pi stopped watching is dropped");
	assert(!sent.message.content.includes(d), "a failure Pi already read in a wait result is not repeated");
	assert.deepEqual(sent.message.details.threads.map((t) => t.threadId), [a, b]);
	await tick(); assert.equal(messages4.length, 1, "and nothing more");

	// Pi's own model call fails after its retries (here, a rate limit). Updates hold instead of
	// starting turns that would fail the same way, then try once when the hold ends.
	idle = false; lastReply = { stopReason: "error", errorMessage: "429 rate_limit_error" };
	idle = true; await settle();
	byThread.get(b).receive(agentState("running_tools", "m3")); byThread.get(b).receive(delta("m4", "complete", "B AGAIN")); byThread.get(b).receive(agentState("idle", "m4"));
	byThread.get(d).receive(agentState("running_tools", "m3")); byThread.get(d).receive(agentState("error", "m4"));
	await tick();
	assert.equal(messages4.length, 1, "no turn starts while Pi's model is failing");
	assert.match(statuses4.at(-1), /2 held after a model error/, "held updates show in the footer");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(messages4.length, 2, "after the hold, one combined update tries again");
	assert.match(messages4[1].message.content, /B AGAIN/); assert.match(messages4[1].message.content, new RegExp(d));

	// That wake-up fails too: the next hold is longer (the last configured step repeats).
	await settle();
	byThread.get(b).receive(agentState("running_tools", "m5")); byThread.get(b).receive(agentState("idle", "m6")); await tick();
	assert.equal(messages4.length, 2, "still held");
	// The user's next message succeeds: the hold ends at once.
	lastReply = { stopReason: "stop" }; await settle();
	assert.equal(messages4.length, 3, "a successful reply releases held updates immediately");
	await handlers4.get("session_shutdown")({}, ctx4);
}

// The quiet period runs from when a state first appeared. A brief interruption before Pi saw it (a
// short burst of work, a reconnect replay) must not restart the clock and split a combined update.
{
	const quietId = "T-00000000-0000-0000-0000-000000000008";
	const tools5 = new Map(); const handlers5 = new Map(); const entries5 = []; const messages5 = [];
	let socket5;
	const pi5 = {
		registerTool(tool) { tools5.set(tool.name, tool); }, on(name, handler) { handlers5.set(name, handler); },
		appendEntry(customType, data) { entries5.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage(message, options) { messages5.push({ message, options }); },
	};
	const ctx5 = { ui: { setStatus() {} }, isIdle: () => true, sessionManager: { getBranch: () => entries5, getSessionId: () => sessionId } };
	ampOrbs(pi5, { launch: async () => quietId, open: async (threadId, capability) => { const opened = await open(threadId, capability); socket5 = opened.socket; return opened; }, quietMs: 100 });
	await handlers5.get("session_start")({}, ctx5);
	snapshot = [{ type: "agent_state", state: "running_tools", messageId: "m1" }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [] } } }];
	await tools5.get("create_thread").execute("call", { prompt: "literal", cwd: "/tmp", mode: "low" }, undefined, undefined, ctx5); await tick();
	socket5.receive(agentState("idle", "m2"));
	await new Promise((resolve) => setTimeout(resolve, 60));
	socket5.receive(agentState("running_tools", "m3")); socket5.receive(agentState("idle", "m4"));
	assert.equal(messages5.length, 0, "not before the quiet period");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(messages5.length, 1, "the completion first seen 120 ms ago goes out, despite the burst at 60 ms");
	await handlers5.get("session_shutdown")({}, ctx5);
}

// Fresh extension instances share only the active session branch, just as a Pi reload does.
function wakeSession(entries = []) {
	const tools = new Map(); const handlers = new Map(); const messages = [];
	let branch = entries; let socket;
	const ctx = { ui: { setStatus() {} }, isIdle: () => true, sessionManager: { getBranch: () => branch, getSessionId: () => sessionId } };
	ampOrbs({
		registerTool(tool) { tools.set(tool.name, tool); }, on(name, handler) { handlers.set(name, handler); },
		appendEntry(customType, data) { branch.push({ type: "custom", customType, data: structuredClone(data) }); },
		sendMessage(message) { messages.push(message); },
	}, { launch: async () => id, open: async (threadId, capability) => {
		const opened = await open(threadId, capability); socket = opened.socket; return opened;
	}, quietMs: 0, holdMs: [100, 300, 1200] });
	return {
		messages, entries,
		call: async (name, args) => JSON.parse((await tools.get(name).execute("call", args, undefined, undefined, ctx)).content[0].text),
		event: (frame) => socket.receive(frame),
		start: () => handlers.get("session_start")({}, ctx),
		stop: () => handlers.get("session_shutdown")({}, ctx),
		settle: async (stopReason) => {
			branch.push({ type: "message", message: { role: "assistant", stopReason } });
			await handlers.get("agent_settled")({}, ctx);
		},
		tree: async (entries) => { branch = entries; await handlers.get("session_tree")({}, ctx); },
	};
}
const replay = (state, messageId, text) => [
	{ type: "agent_state", state, messageId },
	{ type: "message_added", message: { role: "assistant", messageId, content: [{ type: "text", text }] } },
];

await test("a cold idle observer loads the last reply before returning status", async (t) => {
	const session = wakeSession();
	t.after(async () => session.stop());
	snapshot = replay("idle", "cold", "LATEST REPLY");
	await session.start();
	const status = await session.call("get_thread_status", { threadId: id });
	assert.equal(status.response, "LATEST REPLY", "the resume cursor must include stored assistant messages");
	assert.equal(status.settled, true);
});

await test("reload retains an observed new episode without repeating a read or delivered result", async (t) => {
	const advance = () => new Promise((resolve) => setTimeout(resolve, 20));
	let session = wakeSession();
	t.after(async () => session.stop());
	snapshot = replay("working", "m1", "working");
	await session.start(); await session.call("create_thread", { cwd: "/tmp" }); await advance();
	session.event(replay("idle", "m2", "FIRST")); await advance();
	assert.equal(session.messages.length, 1);
	session.event(agentState("working", "m3"));
	await session.stop();
	snapshot = replay("idle", "m4", "SECOND");
	session = wakeSession(session.entries); await session.start(); await advance();
	assert.equal(session.messages.length, 1, "new completion after reload must wake Pi");
	assert.match(session.messages[0].content, /SECOND/);
	await session.stop();
	session = wakeSession(session.entries); await session.start(); await advance();
	assert.equal(session.messages.length, 0, "replaying the reported completion stays quiet");
	session.event(agentState("working", "m5"));
	await session.stop(); snapshot = replay("idle", "m6", "THIRD");
	session = wakeSession(session.entries); await session.start();
	assert.equal((await session.call("wait_for_threads", { threads: [id], timeout_seconds: 1 })).threads[0].response, "THIRD");
	await session.stop();
	session = wakeSession(session.entries); await session.start(); await advance();
	assert.equal(session.messages.length, 0, "a result read in a wait stays seen across reload");
	await session.call("stop_tracking_thread", { threadId: id }); await session.stop();
	session = wakeSession(session.entries); await session.start(); await advance();
	assert.equal(session.messages.length, 0, "reload never restores stopped tracking");
});

await test("reload preserves hold deadlines and the 5, 15, 60, 60 progression", async (t) => {
	const advance = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	let session = wakeSession();
	t.after(async () => session.stop());
	snapshot = replay("working", "m0", "working");
	await session.start(); await session.call("create_thread", { cwd: "/tmp" }); await advance(20);
	// Scale minutes down to 20 ms, with room on either side of each deadline for real timers.
	for (const [index, duration] of [100, 300, 1200, 1200].entries()) {
		const failedAt = Date.now();
		await session.settle("error");
		session.event(agentState("working", `work-${index}`));
		session.event(replay("idle", `done-${index}`, `RESULT-${index}`)); await advance(duration / 2);
		const before = session.messages.length;
		await session.stop(); snapshot = replay("idle", `done-${index}`, `RESULT-${index}`);
		session = wakeSession(session.entries); await session.start();
		await advance(Math.max(0, failedAt + duration * 0.8 - Date.now()));
		assert.equal(session.messages.length, 0, `hold ${index + 1} must survive reload until ${duration} ms`);
		await advance(Math.max(0, failedAt + duration * 1.2 - Date.now()));
		assert.equal(session.messages.length, 1, `hold ${index + 1} expires at the original deadline, not a fresh ${duration} ms after reload`);
		assert.match(session.messages[0].content, new RegExp(`RESULT-${index}`));
		assert.equal(before, index ? 1 : 0, "nothing extra wakes during the hold");
	}
	// Switching branches must neither leak a hold into another branch nor erase the original one.
	await session.settle("error");
	session.event(agentState("working", "held-work")); session.event(replay("idle", "held-done", "HELD"));
	await advance(20); const heldBranch = session.entries;
	snapshot = replay("working", "other-work", "other");
	await session.tree([]); await session.call("create_thread", { cwd: "/tmp" }); await advance(20);
	session.event(replay("idle", "other-done", "OTHER")); await advance(20);
	assert.equal(session.messages.length, 2, "another branch does not inherit the original hold");
	assert.match(session.messages[1].content, /OTHER/);
	snapshot = replay("idle", "held-done", "HELD");
	await session.tree(heldBranch); await advance(20);
	assert.equal(session.messages.length, 2, "returning to the failed branch restores its hold");
	// A successful reply clears both the current hold and its persisted failure count.
	await session.settle("stop");
	assert.equal(session.messages.length, 3, "success releases the held result immediately");
	assert.match(session.messages[2].content, /HELD/);
	await session.stop();
	session = wakeSession(session.entries); await session.start(); await advance(20);
	assert.equal(session.messages.length, 0, "the released result is not repeated after reload");
	session.event(agentState("working", "recovered")); session.event(replay("idle", "recovered-done", "RECOVERED"));
	await advance(20); assert.equal(session.messages.length, 1, "success stays unheld after reload");
	await session.settle("error");
	session.event(agentState("working", "again")); session.event(replay("idle", "again-done", "AGAIN"));
	await advance(80); assert.equal(session.messages.length, 1);
	await advance(40); assert.equal(session.messages.length, 2, "success resets backoff to the first step");
});
console.log("ok: amp-orbs extension");
