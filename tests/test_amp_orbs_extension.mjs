import assert from "node:assert/strict";
import ampOrbs from "../lib/amp-orbs/extension.ts";

const id = "T-00000000-0000-0000-0000-000000000001";
const question = (requestId, status = "pending") => ({ requestId, status, method: "ui.select" });
const plugin = (name, request) => ({ jsonrpc: "2.0", method: "plugin_message", params: { message: { event: `plugin.ui.${name}`, data: { request } } } });
const agentState = (state, messageId) => ({ jsonrpc: "2.0", method: "agent_state", params: { state, messageId } });
let snapshot = [{ type: "agent_state", state: "tool_use", messageId: "m1" }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [question("q1")] } } }];
let acceptMessages = true;

const sockets = [];
class FakeSocket extends EventTarget {
	sent = []; closed = false;
	constructor(capability) { super(); this.capability = capability; setTimeout(() => this.dispatchEvent(new Event("open"))); }
	send(text) {
		const frame = JSON.parse(text); this.sent.push(frame);
		queueMicrotask(() => {
			if (frame.id === 1) { this.receive(snapshot); this.receive({ id: 1, result: {} }); }
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
const ctx = { ui, sessionManager: { getBranch: () => entries } };
const call = async (name, args, signal) => JSON.parse((await tools.get(name).execute("call", args, signal, undefined, ctx)).content[0].text);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
ampOrbs(pi, { launch: async () => id, open });

await handlers.get("session_start")({}, ctx);
assert.equal(sockets.length, 0, "an empty session opens no sockets");
await call("create_thread", { prompt: "literal", cwd: "/tmp", mode: "low" });
assert.equal(entries.at(-1).data[0].threadId, id, "launched threads are persisted");
await tick();
assert.equal(messages.length, 1, "a pending question wakes Pi");
assert.equal(messages[0].options.triggerTurn, true);
sockets[0].receive(plugin("request_added", question("q1")));
assert.equal(messages.length, 1, "the same question does not wake twice");
assert.equal((await call("get_thread_status", { threadId: id })).questions[0].requestId, "q1");

sockets[0].dispatchEvent(new Event("close"));
assert.equal(messages.length, 1, "a lost connection does not wake Pi");
assert.match(statuses.at(-1).value, /disconnected/, "a lost connection is visible in status");
const status = await call("get_thread_status", { threadId: id });
assert.equal(status.connection, "connected", "reading status reconnects with a fresh authorization");
assert.equal(sockets.length, 2); assert.equal(messages.length, 1, "the replayed question does not wake again");

acceptMessages = false;
await assert.rejects(call("send_thread_message", { threadId: id, message: "Red" }), /rejected/);
assert.deepEqual(sockets.map((s) => s.capability), ["read", "read", "write", "write"], "sending upgrades to write; a rejection rereads the snapshot");
await tick();
assert.equal((await call("get_thread_status", { threadId: id })).settled, true, "after a rejection the open question still counts");

acceptMessages = true;
assert.equal((await call("send_thread_message", { threadId: id, message: "Blue" })).accepted, true);
const sent = sockets.at(-1).sent.at(-1);
assert.equal(sent.method, "client_append_user_msg"); assert.equal(sent.params.content[0].text, "Blue"); assert.equal(sent.params.steer, true);
assert.equal((await call("wait_for_threads", { threads: [id], timeout_seconds: 0.01 })).timedOut, true, "the answered question no longer settles the thread");
const waiting = call("wait_for_threads", { threads: [id], timeout_seconds: 5 });
sockets.at(-1).receive(plugin("request_settled", question("q1", "done")));
sockets.at(-1).receive(agentState("working", "m2"));
sockets.at(-1).receive({ jsonrpc: "2.0", method: "delta", params: { role: "assistant", messageId: "m3", blocks: [{ type: "text", text: "RECEIVED Blue" }] } });
sockets.at(-1).receive(agentState("idle", "m3"));
const waited = await waiting;
assert.equal(waited.timedOut, false); assert.equal(waited.threads[0].response, "RECEIVED Blue");
assert.match(messages.at(-1).message.content, /RECEIVED Blue/, "settled work wakes Pi");
assert.match(messages.at(-1).message.content, /Amp orb stopped/);
assert(!messages.at(-1).message.content.includes('"connection"'), "updates are readable prose, not serialized status");
const controller = new AbortController();
sockets.at(-1).receive(agentState("working", "m4"));
const cancelled = call("wait_for_threads", { threads: [id] }, controller.signal); controller.abort();
await assert.rejects(cancelled, /remote work continues/);

const woken = messages.length;
await handlers.get("session_shutdown")({}, ctx);
assert(sockets.at(-1).closed, "shutdown closes the transport");
sockets.at(-1).receive(agentState("idle", "m5"));
assert.equal(messages.length, woken, "a closed session is never woken");

snapshot = [{ type: "agent_state", state: "idle", messageId: "m3" }, { type: "message_added", message: { role: "assistant", messageId: "m3", content: [{ type: "text", text: "RECEIVED Blue" }] } }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests: [] } } }];
await handlers.get("session_start")({}, ctx); await tick();
assert.equal(sockets.at(-1).capability, "read", "reload resumes tracking");
assert.equal(messages.length, woken, "reload does not repeat delivered notifications");
sockets.at(-1).receive(plugin("request_added", question("q2")));
assert.equal(messages.length, woken + 1, "new questions after reload still wake Pi");

const updatesBeforeStop = messages.length;
assert.deepEqual(await call("stop_tracking_thread", { threadId: id }), { threadId: id, wasTracked: true });
assert(sockets.at(-1).closed, "stop tracking closes the local observer");
assert.deepEqual(entries.at(-1).data, [], "stopping is persisted");
assert.equal(statuses.at(-1).value, undefined, "no watched threads clears status");
sockets.at(-1).receive(agentState("idle", "after-stop"));
assert.equal(messages.length, updatesBeforeStop, "stopped observers cannot wake Pi");
const socketsBeforeRestore = sockets.length;
await handlers.get("session_start")({}, ctx);
assert.equal(sockets.length, socketsBeforeRestore, "reload does not restore an unwatched thread");
assert.deepEqual(await call("stop_tracking_thread", { threadId: id }), { threadId: id, wasTracked: false });
await call("get_thread_status", { threadId: id });
assert.equal(sockets.length, socketsBeforeRestore + 1, "explicit status read can resume tracking");
assert.equal(sockets.at(-1).sent[0].method, "client_resume", "unwatch never sends a remote mutation");

await handlers.get("session_tree")({}, { ui, sessionManager: { getBranch: () => [] } });
assert(sockets.at(-1).closed, "moving to a branch without tracking stops observers");
console.log("ok: amp-orbs extension");
