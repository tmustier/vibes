import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { launch, openActor } from "../lib/amp-orbs/connection.ts";
import { archivedError, persistentFailures, ThreadState } from "../lib/amp-orbs/protocol.ts";

const id = "T-00000000-0000-0000-0000-000000000001";
const ack = { jsonrpc: "2.0", id: 1, result: { replayThroughSeq: 5 } };
const question = { requestId: "q1", status: "pending", method: "ui.select", params: { options: { message: "Choose Red or Blue", options: ["Red", "Blue"] } } };
const event = (method, params) => ({ jsonrpc: "2.0", method, params });
const snapshot = (state = "running_tools", requests = []) => [{ type: "agent_state", state, agentMode: "low", messageId: "m1" }, { type: "plugin_message", message: { event: "plugin.ui.snapshot", data: { requests } } }];
const plugin = (name, request) => event("plugin_message", { message: { event: `plugin.ui.${name}`, data: { request } } });
function state() { return new ThreadState(id, "https://ampcode.com"); }
function connected(s, mode = "running_tools", requests = []) { s.apply(snapshot(mode, requests)); s.apply(ack); return s; }

test("snapshot and resume ack can race; initial idle never means completed", () => {
	for (const order of [[ack, snapshot("idle")], [snapshot("idle"), ack]]) {
		const s = state(); s.apply(order[0]); assert.equal(s.status.connection, "connecting"); s.apply(order[1]);
		assert.equal(s.status.connection, "connected"); assert.equal(s.status.settled, false); assert.equal(s.notification(), false);
	}
});
test("incremental question, settle, reply deltas and completion dedupe", () => {
	const s = connected(state());
	s.apply(plugin("request_added", question)); assert.equal(s.status.settled, true); assert.deepEqual(s.status.questions, [question]);
	assert(s.notification()); assert.equal(s.notification(), false);
	s.rearm(); s.apply(plugin("request_settled", { ...question, status: "errored" })); assert.equal(s.status.questions.length, 0);
	s.apply(event("agent_state", { state: "working", messageId: "m2" }));
	for (const text of ["RECEIVED", " Blue"]) s.apply(event("delta", { role: "assistant", messageId: "m3", blockIndex: 0, blocks: [{ type: "text", text }] }));
	s.apply(event("agent_state", { state: "idle", messageId: "m3" }));
	assert.equal(s.status.response, "RECEIVED Blue"); assert.equal(s.status.settled, true); assert(s.notification()); assert.equal(s.notification(), false);
});
test("reconnect snapshots preserve pending question and dedupe across reload", () => {
	const s = connected(state(), "tool_use", [question]); assert(s.notification());
	s.disconnect("Amp actor disconnected"); assert.equal(s.status.settled, false);
	assert.equal(s.notification(), false, "transport disconnects are not agent work");
	s.resetConnection(); s.apply(ack); assert.equal(s.status.connection, "connecting"); s.apply(snapshot("tool_use", [question])); assert.equal(s.notification(), false);
	const restored = connected(new ThreadState(id, "https://ampcode.com", s.checkpoint()), "tool_use", [question]); assert.equal(restored.notification(), false);
	restored.apply(plugin("request_added", { ...question, requestId: "q2" })); assert(restored.notification());
});
test("completed work never wakes again through repeated disconnect and reconnect cycles", () => {
	const s = connected(state());
	const completed = [{ type: "agent_state", state: "idle", messageId: "completed" }, { type: "message_added", message: { role: "assistant", messageId: "completed", content: [{ type: "text", text: "Reviewed" }] } }];
	s.apply(completed); assert(s.notification());
	for (const error of ["Amp actor disconnected", "Amp actor transport error", "Amp actor synchronization timed out"]) {
		s.disconnect(error); assert.equal(s.notification(), false);
		s.resetConnection(); s.apply(ack); s.apply(completed); assert.equal(s.notification(), false);
	}
	const restored = new ThreadState(id, "https://ampcode.com", s.checkpoint());
	restored.apply(ack); restored.apply(completed); assert.equal(restored.notification(), false);
	restored.disconnect("Amp actor disconnected"); assert.equal(restored.notification(), false);
});

test("authorization and protocol failures wake once, including across reload", () => {
	for (const error of ["Amp actor authorization failed (HTTP 401)", "Amp actor endpoint discovery changed", "Invalid Amp actor frame"]) {
		const s = connected(state());
		s.disconnect(error); assert(s.notification()); assert.equal(s.notification(), false);
		s.resetConnection(); connected(s); s.disconnect(error); assert.equal(s.notification(), false);
		const restored = new ThreadState(id, "https://ampcode.com", s.checkpoint());
		connected(restored); restored.disconnect(error); assert.equal(restored.notification(), false);
	}
});

test("brief server and network errors stay quiet until they persist, then wake once", () => {
	for (const error of ["Amp actor authorization failed (HTTP 500)", "Amp actor authorization failed (HTTP 503)", "Amp actor authorization failed (HTTP 429)", "Amp actor connection failed"]) {
		const s = connected(state());
		for (let failures = 1; failures < persistentFailures; failures++) {
			s.disconnect(error, failures); assert.equal(s.notification(), false, `${error} attempt ${failures} is retried quietly`);
		}
		s.disconnect(error, persistentFailures); assert(s.notification(), `${error} wakes once it persists`);
		s.disconnect(error, persistentFailures + 1); assert.equal(s.notification(), false, "a persistent error wakes only once");
		s.resetConnection(); connected(s); s.disconnect(error, 1); assert.equal(s.notification(), false, "a later brief error after recovery is quiet again");
	}
	for (const error of ["Amp actor authorization failed (HTTP 403)", "Amp actor authorization failed (HTTP 409)"]) {
		const s = connected(state()); s.disconnect(error, 1); assert(s.notification(), `${error} is not transient and wakes at once`);
	}
});

test("an archived thread settles quietly, and a later reconnect clears it", () => {
	const s = connected(state(), "tool_use", [question]); assert(s.notification());
	s.archive();
	assert.equal(s.status.archived, true); assert.equal(s.status.settled, true, "archiving releases waits");
	assert.deepEqual(s.status.questions, []); assert.equal(s.notification(), false, "archiving is not a failure");
	s.resetConnection(); assert.equal(s.status.archived, false);
});

test("human-only questions and approvals cannot be cancelled by a model reply", () => {
	for (const human of [{ ...question, requiresHuman: true }, { ...question, params: { options: { requiresHuman: true } } }]) {
		const s = connected(state(), "tool_use", [human]); assert.throws(() => s.assertCanSend(), /Human action required/);
	}
	const s = connected(state(), "tool_use", [question]); assert.doesNotThrow(() => s.assertCanSend());
	s.apply(event("tool_approval_queue", { approvals: [{ id: "approval1", tool: "Bash", command: "write" }] }));
	assert.equal(s.status.settled, true); assert.throws(() => s.assertCanSend(), /Human action required/);
	s.apply(event("tool_approval_queue", { approvals: [] })); s.disconnect("gone"); assert.throws(() => s.assertCanSend(), /not synchronized/);
});
test("actual runtime error protocol does not become success on idle", () => {
	for (const type of ["error", "executor_error"]) {
		const s = connected(state()); s.apply(event(type, { code: "INTERNAL_ERROR", message: "Executor stopped unexpectedly", seq: 9 }));
		s.apply(event("agent_state", { state: "idle" }));
		assert.equal(s.status.error, "Executor stopped unexpectedly"); assert.equal(s.status.settled, true); assert(s.notification());
	}
});
test("a failed assistant attempt that Amp retries does not wake; one left failed at idle does", () => {
	const delta = (messageId, state) => event("delta", { role: "assistant", messageId, blocks: [{ type: "text", text: "x" }], contentMode: "snapshot", state });
	const retried = connected(state());
	retried.apply(delta("m2", "error"));
	assert.equal(retried.notification(), false, "a failed attempt while running is not yet a failure");
	retried.apply(delta("m3", "streaming")); retried.apply(event("agent_state", { state: "running_tools", messageId: "m3" }));
	assert.equal(retried.status.error, undefined); assert.equal(retried.notification(), false, "the retry carried on");
	retried.apply(event("agent_state", { state: "idle", messageId: "m3" }));
	assert.equal(retried.status.error, undefined, "idle after a successful retry is completion, not failure");
	assert(retried.notification(), "and wakes once as completion");

	const left = connected(state());
	left.apply(delta("m2", "error")); assert.equal(left.notification(), false);
	left.apply(event("agent_state", { state: "idle", messageId: "m2" }));
	assert.equal(left.status.error, "Amp assistant message failed"); assert(left.notification(), "a failure left at idle wakes");
	assert.equal(left.notification(), false, "and only once");
});

test("follow-up cannot settle on old question or old idle, including reload before new work", () => {
	const s = connected(state(), "tool_use", [question]); s.notification(); s.rearm();
	assert.equal(s.status.settled, false);
	const restored = new ThreadState(id, "https://ampcode.com", s.checkpoint());
	restored.apply([{ type: "message_added", message: { role: "assistant", messageId: "m1", content: [{ type: "text", text: "old" }] } }]);
	connected(restored, "idle", [question]); assert.equal(restored.status.settled, false); assert.equal(restored.notification(), false);
	restored.apply(plugin("request_settled", { ...question, status: "errored" }));
	restored.apply(event("agent_state", { state: "working", messageId: "m2" }));
	restored.apply(event("delta", { role: "assistant", messageId: "m3", blocks: [{ type: "text", text: "new response" }] }));
	restored.apply(event("agent_state", { state: "idle", messageId: "m3" }));
	assert.equal(restored.status.settled, true); assert.equal(restored.status.response, "new response"); assert(restored.notification());
});

test("requiresHuman on the invoking tool also protects its UI request", () => {
	for (const type of ["message_added", "delta"]) {
		const s = connected(state());
		const block = { type: "tool_use", id: "tu1", name: "ask_user_choice", input: { requiresHuman: true } };
		s.apply(type === "message_added" ? event(type, { message: { role: "assistant", messageId: "m1", content: [block] } }) : event(type, { role: "assistant", messageId: "m1", blocks: [block] }));
		s.apply(plugin("request_added", { ...question, invocation: { kind: "tool", id: "tu1" } }));
		assert.equal(s.status.questions[0].requiresHuman, true); assert.throws(() => s.assertCanSend(), /Human action required/);
	}
});

test("notification: new errors and approvals are independent of existing or rearm-ignored questions", () => {
	for (const rearm of [false, true]) {
		const s = connected(state(), "tool_use", [question]); assert(s.notification());
		if (rearm) s.rearm();
		s.apply(event("executor_error", { message: "Executor failed" }));
		assert.equal(s.status.settled, true);
		assert(s.notification(), "new executor error must wake despite an already-notified question");
		assert.equal(s.notification(), false);
		s.apply(event("tool_approval_queue", { approvals: [{ id: "a1", tool: "Bash" }] }));
		assert(s.notification(), "new approval must wake despite the question and error");
		s.apply(event("executor_error", { message: "Another failure" }));
		assert(s.notification(), "new error must wake despite the approval");
		assert.equal(s.notification(), false);
	}
});

test("notification: partial question settlement never renotifies remaining requests", () => {
	const s = connected(state(), "tool_use", [question]); assert(s.notification());
	const q2 = { ...question, requestId: "q2" };
	s.apply(plugin("request_added", q2)); assert(s.notification());
	s.apply(plugin("request_settled", { ...question, status: "done" }));
	assert.equal(s.notification(), false, "q2 was already delivered");
	s.apply(plugin("request_added", { ...question, requestId: "q3" })); assert(s.notification());
});

test("notification: reordered reconnect snapshots and persisted individual identities dedupe", () => {
	const q2 = { ...question, requestId: "q2" };
	const s = connected(state(), "tool_use", [question, q2]); assert(s.notification());
	s.resetConnection(); connected(s, "tool_use", [q2, question]);
	assert.equal(s.notification(), false, "request ordering is not new input");
	const restored = connected(new ThreadState(id, "https://ampcode.com", s.checkpoint()), "tool_use", [q2]);
	assert.equal(restored.notification(), false, "q1 settling while Pi was closed must not renotify q2");
	restored.apply(plugin("request_added", { ...question, requestId: "q3" })); assert(restored.notification());
});

test("notification: approval identities ignore queue ordering and partial settlement", () => {
	const s = connected(state());
	s.apply(event("tool_approval_queue", { approvals: [{ id: "a1", tool: "Bash" }, { id: "a2", tool: "Bash" }] })); assert(s.notification());
	s.apply(event("tool_approval_queue", { approvals: [{ tool: "Bash", id: "a2" }, { tool: "Bash", id: "a1" }] }));
	assert.equal(s.notification(), false);
	s.apply(event("tool_approval_queue", { approvals: [{ id: "a2", tool: "Bash" }] })); assert.equal(s.notification(), false);
	s.apply(event("tool_approval_queue", { approvals: [{ id: "a3", tool: "Bash" }] })); assert(s.notification());
});

// Boundary tests through a local Amp server and a fake `amp` CLI on PATH.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "amp-orbs-"));
const authorizations = [];
const replies = [];
const server = http.createServer((request, response) => {
	if (request.method === "POST") {
		authorizations.push(request.headers.authorization);
		const [status, body = "private detail"] = [replies.shift()].flat();
		return status === 200 ? response.end(JSON.stringify({ wsToken: "ws", threadVersion: 7 })) : response.writeHead(status).end(body);
	}
	response.end('<script>window.x={threadActorConfig:{baseURL:"https://default:public@127.0.0.1:9/actors",poolName:"k8s"}}</script>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sessionKey = `apiKey@${origin}/#cli-account=work&session=s2`;
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)); };
write(path.join(scratch, "amp/accounts.json"), { active: { [`${origin}/`]: "work" }, accounts: [{ serverURL: `${origin}/`, userID: "personal", legacy: true }, { serverURL: `${origin}/`, userID: "work", sessionID: "s2" }] });
write(path.join(scratch, "amp/accounts/secrets.json"), { [sessionKey]: "stale" });
write(path.join(scratch, "amp/secrets.json"), { [`apiKey@${origin}/`]: "personal" });
write(path.join(scratch, "bin/amp"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "usage") {
	fs.appendFileSync(${JSON.stringify(path.join(scratch, "refreshes"))}, "usage\\n");
	fs.writeFileSync(${JSON.stringify(path.join(scratch, "amp/accounts/secrets.json"))}, JSON.stringify({ ${JSON.stringify(sessionKey)}: "fresh" }));
} else {
	fs.readFileSync(0); // Hangs unless the caller closes stdin, as real amp -x does.
	fs.writeFileSync(${JSON.stringify(path.join(scratch, "launch-args"))}, JSON.stringify(args));
	console.log("Thread: https://ampcode.com/threads/${id}");
}
`);
fs.chmodSync(path.join(scratch, "bin/amp"), 0o755);
Object.assign(process.env, { AMP_URL: origin, XDG_DATA_HOME: scratch, PATH: `${path.join(scratch, "bin")}:${process.env.PATH}` });
delete process.env.AMP_API_KEY;
after(() => { server.close(); fs.rmSync(scratch, { recursive: true, force: true }); });
const refreshes = () => fs.existsSync(path.join(scratch, "refreshes")) ? fs.readFileSync(path.join(scratch, "refreshes"), "utf8").split("\n").length - 1 : 0;
const openOnce = async () => { const { socket, version } = await openActor(id, "read", new AbortController().signal); socket.addEventListener("error", () => {}); socket.close(); return version; };

test("authorization uses the active CLI session, refreshes once through the CLI on 401, and never bypasses denial", async () => {
	replies.push(401, 200);
	assert.equal(await openOnce(), 7);
	assert.deepEqual(authorizations.splice(0), ["Bearer stale", "Bearer fresh"]); assert.equal(refreshes(), 1);
	replies.push(403);
	await assert.rejects(openOnce(), (error) => /HTTP 403/.test(error.message) && !error.message.includes("private detail"));
	assert.equal(refreshes(), 1);
	process.env.AMP_API_KEY = "env-key"; replies.push(401);
	await assert.rejects(openOnce(), /HTTP 401/);
	delete process.env.AMP_API_KEY;
	assert.deepEqual(authorizations.splice(0), ["Bearer fresh", "Bearer env-key"]); assert.equal(refreshes(), 1);
	const accounts = JSON.parse(fs.readFileSync(path.join(scratch, "amp/accounts.json")));
	accounts.active[`${origin}/`] = "personal"; write(path.join(scratch, "amp/accounts.json"), accounts); replies.push(200);
	await openOnce(); assert.deepEqual(authorizations.splice(0), ["Bearer personal"]);
});

test("only Amp's THREAD_ARCHIVED code marks a thread archived", async () => {
	replies.push([409, JSON.stringify({ error: "This thread is archived", code: "THREAD_ARCHIVED" })]);
	await assert.rejects(openOnce(), (error) => error.message === archivedError);
	replies.push(409);
	await assert.rejects(openOnce(), (error) => /HTTP 409/.test(error.message) && !error.message.includes("private detail"));
	authorizations.splice(0);
});

test("launch passes the literal prompt and options, closes stdin, and returns the canonical thread ID", async () => {
	const prompt = "literal $(touch should-not-exist)\nno rephrasing";
	assert.equal(await launch({ prompt, cwd: scratch, mode: "external-agent:claude-code", project: "org/repo", features: ["model:claude-opus-5-5", "effort:high"] }), id);
	const args = JSON.parse(fs.readFileSync(path.join(scratch, "launch-args")));
	assert.equal(args[args.indexOf("-ox") + 1], prompt);
	assert.equal(args[args.indexOf("--features") + 1], "model:claude-opus-5-5,effort:high");
	assert.equal(args[args.indexOf("--project") + 1], "org/repo");
	assert(!fs.existsSync(path.join(scratch, "should-not-exist")));
});
