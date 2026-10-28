import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
		assert.equal(s.status.connection, "connected"); assert.equal(s.status.settled, false); assert.equal(s.markSeen(), false);
	}
});
test("incremental question, settle, reply deltas and completion dedupe", () => {
	const s = connected(state());
	s.apply(plugin("request_added", question)); assert.equal(s.status.settled, true); assert.deepEqual(s.status.questions, [question]);
	assert(s.markSeen()); assert.equal(s.markSeen(), false);
	s.rearm(); s.apply(plugin("request_settled", { ...question, status: "errored" })); assert.equal(s.status.questions.length, 0);
	s.apply(event("agent_state", { state: "working", messageId: "m2" }));
	for (const text of ["RECEIVED", " Blue"]) s.apply(event("delta", { role: "assistant", messageId: "m3", blockIndex: 0, blocks: [{ type: "text", text }] }));
	s.apply(event("agent_state", { state: "idle", messageId: "m3" }));
	assert.equal(s.status.response, "RECEIVED Blue"); assert.equal(s.status.settled, true); assert(s.markSeen()); assert.equal(s.markSeen(), false);
});
test("reconnect snapshots preserve pending question and dedupe across reload", () => {
	const s = connected(state(), "tool_use", [question]); assert(s.markSeen());
	s.disconnect("Amp actor disconnected"); assert.equal(s.status.settled, false);
	assert.equal(s.markSeen(), false, "transport disconnects are not agent work");
	s.resetConnection(); s.apply(ack); assert.equal(s.status.connection, "connecting"); s.apply(snapshot("tool_use", [question])); assert.equal(s.markSeen(), false);
	const restored = connected(new ThreadState(id, "https://ampcode.com", s.checkpoint()), "tool_use", [question]); assert.equal(restored.markSeen(), false);
	restored.apply(plugin("request_added", { ...question, requestId: "q2" })); assert(restored.markSeen());
});
test("completed work never wakes again through repeated disconnect and reconnect cycles", () => {
	const s = connected(state());
	const completed = [{ type: "agent_state", state: "idle", messageId: "completed" }, { type: "message_added", message: { role: "assistant", messageId: "completed", content: [{ type: "text", text: "Reviewed" }] } }];
	s.apply(completed); assert(s.markSeen());
	for (const error of ["Amp actor disconnected", "Amp actor transport error", "Amp actor synchronization timed out"]) {
		s.disconnect(error); assert.equal(s.markSeen(), false);
		s.resetConnection(); s.apply(ack); s.apply(completed); assert.equal(s.markSeen(), false);
	}
	const restored = new ThreadState(id, "https://ampcode.com", s.checkpoint());
	restored.apply(ack); restored.apply(completed); assert.equal(restored.markSeen(), false);
	restored.disconnect("Amp actor disconnected"); assert.equal(restored.markSeen(), false);
});

test("cold idle restores distinguish new user work from retries and history replay", () => {
	const user = (messageId) => ({ type: "message_added", message: { role: "user", messageId, content: [{ type: "text", text: "Task" }] } });
	const reply = (messageId) => ({ type: "message_added", message: { role: "assistant", messageId, content: [{ type: "text", text: "Same answer" }] } });
	const idle = (messageId) => ({ type: "agent_state", state: "idle", messageId });
	const first = [user("input-A"), reply("answer-A"), idle("answer-A")];
	const next = [user("input-A"), reply("answer-A"), user("input-B"), reply("answer-B"), idle("answer-B")];
	for (const reconnect of [false, true]) {
		const original = new ThreadState(id, "https://ampcode.com");
		original.apply(ack); original.apply(first); assert(original.markSeen());
		const restored = reconnect ? original : new ThreadState(id, "https://ampcode.com", original.checkpoint());
		if (reconnect) restored.resetConnection();
		restored.apply(ack); restored.apply(next);
		assert(restored.markSeen(), "work started and completed entirely offline still reports");
		assert.equal(restored.markSeen(), false);
		assert.equal(restored.checkpoint().userMessageId, "input-B");
		const replayed = new ThreadState(id, "https://ampcode.com", restored.checkpoint());
		// Older user messages in full replay must not advance the current task.
		replayed.apply(next); replayed.apply(ack); assert.equal(replayed.markSeen(), false);
		replayed.resetConnection(); replayed.apply(ack);
		replayed.apply([...next.slice(0, -1), reply("retry-with-new-id"), idle("retry-with-new-id")]);
		assert.equal(replayed.markSeen(), false, "same-input retries with new assistant IDs stay deduplicated");
		// A live input invalidates the old idle result before the new assistant starts.
		replayed.apply([user("input-C")]);
		assert.equal(replayed.status.settled, false);
		assert.equal(replayed.markSeen(), false, "queued work does not report the previous answer");
		replayed.apply([reply("answer-C"), idle("answer-C")]);
		assert(replayed.markSeen()); assert.equal(replayed.markSeen(), false);
	}
});

test("legacy reported outcomes stay seen after the checkpoint format changes", () => {
	for (const failure of [false, true]) {
		const response = "Already reported";
		const identity = failure ? ["error", "m1", "Old failure"] : ["idle", "m1", "m1", response];
		const checkpoint = { notificationKeys: [createHash("sha256").update(JSON.stringify(identity)).digest("hex")] };
		const hydrate = (saved, messageId = "m1") => {
			const restored = new ThreadState(id, "https://ampcode.com", saved);
			restored.apply(ack);
			restored.apply([{ type: "agent_state", state: failure ? "error" : "idle", messageId }, { type: "message_added", message: { role: "assistant", messageId, content: [{ type: "text", text: response }] } }]);
			if (failure) restored.apply(event("executor_error", { message: "Old failure" }));
			return restored;
		};
		const restored = hydrate(checkpoint);
		assert.equal(restored.markSeen(), false, "upgrading must not repeat an already reported outcome");
		assert.equal(hydrate(restored.checkpoint()).markSeen(), false, "a second reload remains quiet");
		assert(hydrate(checkpoint, "different").markSeen(), "a different outcome is not blanket-acknowledged");
		restored.apply(event("agent_state", { state: "working", messageId: "m2" }));
		assert.equal(restored.checkpoint().episode, 1, "new work advances past the migrated outcome");
		restored.apply(event("delta", { role: "assistant", messageId: "m3", blocks: [{ type: "text", text: response }] }));
		restored.apply(event("agent_state", { state: "idle", messageId: "m3" }));
		assert(restored.markSeen(), "new work with the same text is still new");
		assert.equal(restored.markSeen(), false, "new work also deduplicates");
	}
});

test("authorization and protocol failures wake once, including across reload", () => {
	for (const error of ["Amp actor authorization failed (HTTP 401)", "Amp actor endpoint discovery changed", "Invalid Amp actor frame"]) {
		const s = connected(state());
		s.disconnect(error); assert(s.markSeen()); assert.equal(s.markSeen(), false);
		s.resetConnection(); connected(s); s.disconnect(error); assert.equal(s.markSeen(), false);
		const restored = new ThreadState(id, "https://ampcode.com", s.checkpoint());
		connected(restored); restored.disconnect(error); assert.equal(restored.markSeen(), false);
	}
});

test("brief server and network errors stay quiet until they persist, then wake once", () => {
	for (const error of ["Amp actor authorization failed (HTTP 500)", "Amp actor authorization failed (HTTP 503)", "Amp actor authorization failed (HTTP 429)", "Amp actor connection failed"]) {
		const s = connected(state());
		for (let failures = 1; failures < persistentFailures; failures++) {
			s.disconnect(error, failures); assert.equal(s.markSeen(), false, `${error} attempt ${failures} is retried quietly`);
		}
		s.disconnect(error, persistentFailures); assert(s.markSeen(), `${error} wakes once it persists`);
		s.disconnect(error, persistentFailures + 1); assert.equal(s.markSeen(), false, "a persistent error wakes only once");
		s.resetConnection(); connected(s); s.disconnect(error, 1); assert.equal(s.markSeen(), false, "a later brief error after recovery is quiet again");
	}
	for (const error of ["Amp actor authorization failed (HTTP 403)", "Amp actor authorization failed (HTTP 409)"]) {
		const s = connected(state()); s.disconnect(error, 1); assert(s.markSeen(), `${error} is not transient and wakes at once`);
	}
});

test("an archived thread settles quietly, and a later reconnect clears it", () => {
	const s = connected(state(), "tool_use", [question]); assert(s.markSeen());
	s.archive();
	assert.equal(s.status.archived, true); assert.equal(s.status.settled, true, "archiving releases waits");
	assert.deepEqual(s.status.questions, []); assert.equal(s.markSeen(), false, "archiving is not a failure");
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
		assert.equal(s.status.error, "Executor stopped unexpectedly"); assert.equal(s.status.settled, true); assert(s.markSeen());
	}
});
test("a failed assistant attempt that Amp retries does not wake; one left failed at idle does", () => {
	const delta = (messageId, state) => event("delta", { role: "assistant", messageId, blocks: [{ type: "text", text: "x" }], contentMode: "snapshot", state });
	const retried = connected(state());
	retried.apply(delta("m2", "error"));
	assert.equal(retried.markSeen(), false, "a failed attempt while running is not yet a failure");
	retried.apply(delta("m3", "streaming")); retried.apply(event("agent_state", { state: "running_tools", messageId: "m3" }));
	assert.equal(retried.status.error, undefined); assert.equal(retried.markSeen(), false, "the retry carried on");
	retried.apply(event("agent_state", { state: "idle", messageId: "m3" }));
	assert.equal(retried.status.error, undefined, "idle after a successful retry is completion, not failure");
	assert(retried.markSeen(), "and wakes once as completion");

	const left = connected(state());
	left.apply(delta("m2", "error")); assert.equal(left.markSeen(), false);
	left.apply(event("agent_state", { state: "idle", messageId: "m2" }));
	assert.equal(left.status.error, "Amp assistant message failed"); assert(left.markSeen(), "a failure left at idle wakes");
	assert.equal(left.markSeen(), false, "and only once");

	// An orb can resume after a reported failure and later reply successfully.
	left.apply(event("agent_state", { state: "running_tools", messageId: "m3" })); left.apply(delta("m4", "complete"));
	left.apply(event("agent_state", { state: "idle", messageId: "m4" }));
	assert.equal(left.status.error, undefined, "a later successful reply is completion, not the old failure");
	assert(left.markSeen(), "and is reported as such");
});

test("follow-up cannot settle on old question or old idle, including reload before new work", () => {
	const s = connected(state(), "tool_use", [question]); s.markSeen(); s.rearm();
	assert.equal(s.status.settled, false);
	const restored = new ThreadState(id, "https://ampcode.com", s.checkpoint());
	restored.apply([{ type: "message_added", message: { role: "assistant", messageId: "m1", content: [{ type: "text", text: "old" }] } }]);
	connected(restored, "idle", [question]); assert.equal(restored.status.settled, false); assert.equal(restored.markSeen(), false);
	restored.apply(plugin("request_settled", { ...question, status: "errored" }));
	restored.apply(event("agent_state", { state: "working", messageId: "m2" }));
	restored.apply(event("delta", { role: "assistant", messageId: "m3", blocks: [{ type: "text", text: "new response" }] }));
	restored.apply(event("agent_state", { state: "idle", messageId: "m3" }));
	assert.equal(restored.status.settled, true); assert.equal(restored.status.response, "new response"); assert(restored.markSeen());
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
		const s = connected(state(), "tool_use", [question]); assert(s.markSeen());
		if (rearm) s.rearm();
		s.apply(event("executor_error", { message: "Executor failed" }));
		assert.equal(s.status.settled, true);
		assert(s.markSeen(), "new executor error must wake despite an already-notified question");
		assert.equal(s.markSeen(), false);
		s.apply(event("tool_approval_queue", { approvals: [{ id: "a1", tool: "Bash" }] }));
		assert(s.markSeen(), "new approval must wake despite the question and error");
		s.apply(event("executor_error", { message: "Another failure" }));
		assert.equal(s.markSeen(), false, "a further error before Pi acts or the orb works again is the same failure");
		s.apply(event("agent_state", { state: "running_tools", messageId: "m9" }));
		assert.equal(s.status.error, undefined, "working again clears the earlier runtime error");
		s.apply(event("executor_error", { message: "Another failure" }));
		assert(s.markSeen(), "a failure after the orb started new work wakes again");
		assert.equal(s.markSeen(), false);
	}
});

// Replays failed reply attempts retried by Amp
// under new message IDs while streaming, then stopped in its own "error" state.
test("retried attempts never wake; Amp's error state settles and wakes once per episode", () => {
	const delta = (messageId, state) => event("delta", { role: "assistant", messageId, blocks: [{ type: "text", text: "x" }], contentMode: "snapshot", state });
	const s = connected(state());
	s.apply(delta("m2", "error"));
	for (let i = 3; i < 13; i++) {
		s.apply(event("agent_state", { state: "streaming", messageId: `m${i}` })); s.apply(delta(`m${i}`, i % 2 ? "error" : "streaming"));
		assert.equal(s.markSeen(), false, `retry ${i} while the orb works does not wake`);
	}
	s.apply(delta("m13", "error")); s.apply(event("agent_state", { state: "error", messageId: "m13" }));
	assert.equal(s.status.settled, true, "Amp's error state is a settled failure, so waits return");
	assert.equal(s.status.error, "Amp assistant message failed");
	assert(s.markSeen(), "a stopped failure wakes"); assert.equal(s.markSeen(), false, "once");
	s.resetConnection(); s.apply(ack); s.apply([{ type: "agent_state", state: "error", messageId: "m13" }]);
	assert.equal(s.markSeen(), false, "a reconnect replay of the same stopped failure does not wake");
	const restored = new ThreadState(id, "https://ampcode.com", s.checkpoint()); restored.apply(ack); restored.apply([{ type: "agent_state", state: "error", messageId: "m13" }]);
	assert.equal(restored.markSeen(), false, "nor does a reload");
	restored.rearm(); restored.apply(event("agent_state", { state: "streaming", messageId: "m14" }));
	restored.apply(delta("m15", "error")); restored.apply(event("agent_state", { state: "error", messageId: "m15" }));
	assert(restored.markSeen(), "after Pi steers the orb, a new stopped failure wakes");

	const plain = connected(state()); plain.apply(event("agent_state", { state: "error", messageId: "m2" }));
	assert.equal(plain.status.error, "Amp orb stopped with an error"); assert(plain.markSeen());
});

test("an orb that resumes on its own reports again; a failure Pi never saw is reported once", () => {
	const stop = (s, messageId) => s.apply(event("agent_state", { state: "error", messageId }));
	const work = (s, messageId) => s.apply(event("agent_state", { state: "running_tools", messageId }));
	const reported = connected(state());
	stop(reported, "m2"); assert(reported.markSeen());
	work(reported, "m3"); stop(reported, "m4");
	assert(reported.markSeen(), "new work after a reported failure starts a new episode");
	work(reported, "m5"); reported.apply(event("agent_state", { state: "idle", messageId: "m5" }));
	assert(reported.markSeen(), "and its completion is news too");

	const flapping = connected(state());
	stop(flapping, "m2"); assert.equal(flapping.unseen().length, 1, "unseen() reads without marking");
	work(flapping, "m3"); assert.deepEqual(flapping.unseen(), [], "working again");
	stop(flapping, "m4");
	assert(flapping.markSeen(), "an unreported failure that recurs is still one failure"); assert.equal(flapping.markSeen(), false);
});

test("notification: partial question settlement never renotifies remaining requests", () => {
	const s = connected(state(), "tool_use", [question]); assert(s.markSeen());
	const q2 = { ...question, requestId: "q2" };
	s.apply(plugin("request_added", q2)); assert(s.markSeen());
	s.apply(plugin("request_settled", { ...question, status: "done" }));
	assert.equal(s.markSeen(), false, "q2 was already delivered");
	s.apply(plugin("request_added", { ...question, requestId: "q3" })); assert(s.markSeen());
});

test("notification: reordered reconnect snapshots and persisted individual identities dedupe", () => {
	const q2 = { ...question, requestId: "q2" };
	const s = connected(state(), "tool_use", [question, q2]); assert(s.markSeen());
	s.resetConnection(); connected(s, "tool_use", [q2, question]);
	assert.equal(s.markSeen(), false, "request ordering is not new input");
	const restored = connected(new ThreadState(id, "https://ampcode.com", s.checkpoint()), "tool_use", [q2]);
	assert.equal(restored.markSeen(), false, "q1 settling while Pi was closed must not renotify q2");
	restored.apply(plugin("request_added", { ...question, requestId: "q3" })); assert(restored.markSeen());
});

test("notification: approval identities ignore queue ordering and partial settlement", () => {
	const s = connected(state());
	s.apply(event("tool_approval_queue", { approvals: [{ id: "a1", tool: "Bash" }, { id: "a2", tool: "Bash" }] })); assert(s.markSeen());
	s.apply(event("tool_approval_queue", { approvals: [{ tool: "Bash", id: "a2" }, { tool: "Bash", id: "a1" }] }));
	assert.equal(s.markSeen(), false);
	s.apply(event("tool_approval_queue", { approvals: [{ id: "a2", tool: "Bash" }] })); assert.equal(s.markSeen(), false);
	s.apply(event("tool_approval_queue", { approvals: [{ id: "a3", tool: "Bash" }] })); assert(s.markSeen());
});

// Boundary tests through a local Amp server and a fake `amp` CLI on PATH.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "amp-orbs-"));
const authorizations = [];
const replies = [];
const creations = [];
const created = [];
const server = http.createServer(async (request, response) => {
	if (request.url === "/api/internal?createRemoteExecutorThread") {
		let body = ""; for await (const chunk of request) body += chunk;
		creations.push({ authorization: request.headers.authorization, ...JSON.parse(body) });
		return response.end(JSON.stringify(created.shift()));
	}
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
} else if (args[0] === "projects") {
	fs.readFileSync(0); // Hangs unless the caller closes stdin, as real amp does.
	if (args[1] === "get") {
		if (args[2] !== "org/repo") { console.error("Error: No accessible Amp project matches"); process.exit(1); }
		console.log(JSON.stringify({ id: "project-named", name: "repo" }));
	} else {
		const status = fs.readFileSync(${JSON.stringify(path.join(scratch, "project-status"))}, "utf8");
		console.log(JSON.stringify(status === "matched" ? { status, project: { id: "project-inferred" } } : { status, project: null }));
	}
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

test("launch creates the orb as amp -ox does, opening with a hidden placeholder for Pi's labelled task", async () => {
	const sessionId = "01a182cf-a771-70ae-a278-bf133e8dca4e";
	const options = { cwd: scratch, mode: "external-agent:claude-code", title: "Task", features: ["model:claude-opus-5-5", "effort:high"], sessionId };
	created.push({ ok: true, result: { threadID: id } });
	assert.equal(await launch({ ...options, project: "org/repo" }), id);
	const [{ authorization, method, params: { content: [placeholder, ...rest], userState: _, ...params } }] = creations.splice(0);
	assert.equal(authorization, "Bearer personal", "the active CLI account creates the orb");
	assert.equal(method, "createRemoteExecutorThread");
	assert.deepEqual(params, {
		agentMode: "external-agent:claude-code", features: ["model:claude-opus-5-5", "effort:high"], projectID: "project-named",
		executeMode: true, title: "Task", threadMeta: { visibility: "thread_workspace_shared" },
	});
	assert.deepEqual(rest, [], "the prompt is not part of the launch");
	assert(placeholder.hidden && placeholder.text.includes(sessionId), "the thread opens with a hidden placeholder naming the Pi session");
	for (const [status, projectID] of [["matched", "project-inferred"], ["unmatched", null]]) {
		fs.writeFileSync(path.join(scratch, "project-status"), status); created.push({ ok: true, result: { threadID: id } });
		await launch(options);
		assert.equal(creations.splice(0)[0].params.projectID, projectID, "without a project, cwd's Git remotes choose it");
	}
	await assert.rejects(launch({ ...options, project: "missing/repo" }), /No accessible Amp project matches missing\/repo/);
	assert.equal(creations.length, 0, "an unknown project creates nothing");
	created.push({ ok: false, error: { code: "invalid-params", message: "Unknown agent mode" } });
	await assert.rejects(launch(options), /Amp refused to create the orb: Unknown agent mode/);
	authorizations.splice(0);
});
