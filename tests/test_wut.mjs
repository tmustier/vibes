// Exercise the registered command/events; only the provider and clock are replaced.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const scratch = mkdtempSync(join(tmpdir(), "wut-test-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
const configPath = join(scratch, "wut.json");
const loaded = await discoverAndLoadExtensions([resolve("extensions/wut.ts")], scratch, scratch);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const handlers = new Map([...extension.handlers].map(([event, callbacks]) => [event, callbacks[0]]));
const sent = [];
const notices = [];
const intervals = new Set();
let tick;
let now = 1_000_000;
const originals = { now: Date.now, setInterval, clearInterval };
Date.now = () => now;
globalThis.setInterval = (callback) => {
	tick = callback;
	const timer = { unref() {} };
	intervals.add(timer);
	return timer;
};
globalThis.clearInterval = (timer) => intervals.delete(timer);

const response = (text, stopReason = "stop") => ({
	role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage: text,
});
let complete = async () => response("A short update");
const model = { provider: "openai-codex", id: "gpt-6-luna" };
const fallback = { provider: "openai", id: "gpt-6-luna" };
const custom = { provider: "openrouter", id: "anthropic/custom-model" };
const attempts = [];
const branch = [];
let aborts = 0;
const ctx = {
	mode: "rpc", hasUI: true, model: { provider: "anthropic", id: "test-session" }, isIdle: () => false,
	abort: () => { aborts++; },
	ui: { notify: (text) => notices.push(text) },
	sessionManager: { getBranch: () => branch },
	modelRegistry: {
		find: (provider, id) => [model, fallback, custom].find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
		complete: async (selected, request, options) => {
			attempts.push({ selected, request, options });
			return complete(options, selected);
		},
	},
};
try {
	loaded.runtime.sendUserMessage = (...args) => sent.push(args);
	const command = extension.commands.get("wut").handler;
	await handlers.get("input")({ source: "interactive" }, ctx);
	branch.push(
		{ type: "message", message: { role: "user", content: "Fix the import", timestamp: now } },
		{ type: "message", message: { role: "assistant", content: [
			{ type: "text", text: "Checking dependencies" },
			{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
		] } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "Missing module" }] } },
		{ type: "message", message: { role: "user", content: "<wut_watchdog> Reassess", timestamp: now + 1 } },
		{ type: "compaction", summary: "The old import path no longer exists" },
	);
	await command("", ctx);
	assert.equal(attempts.at(-1).selected, model, "wut should prefer openai-codex/gpt-6-luna");
	const prompt = attempts.at(-1).request.messages[0].content[0].text;
	for (const expected of ["Fix the import", "Checking dependencies", "Agent ran tool bash", "(FAILED)", "Missing module", "old import path"]) {
		assert.ok(prompt.includes(expected), expected);
	}
	assert.match(prompt, /last message \(the goal\):\nFix the import/);
	assert.equal(notices.at(-1), "A short update");

	ctx.modelRegistry.hasConfiguredAuth = () => false;
	await command("", ctx);
	assert.equal(attempts.at(-1).selected, ctx.model, "wut should keep the session-model fallback without observer auth");
	ctx.modelRegistry.hasConfiguredAuth = () => true;

	for (const thrown of [false, true]) {
		attempts.length = 0;
		complete = async (_options, selected) => {
			if (selected === fallback) return response("Fallback update");
			if (thrown) throw new Error("Authentication failed");
			return response("Authentication failed", "error");
		};
		await command("", ctx);
		assert.deepEqual(attempts.map((a) => a.selected), [model, fallback]);
		assert.equal(notices.at(-1), "Fallback update");
		assert.deepEqual(attempts[0].request, attempts[1].request);
		assert.equal(attempts[0].options.sessionId, attempts[1].options.sessionId);
	}

	ctx.modelRegistry.hasConfiguredAuth = (selected) => selected === fallback;
	await command("", ctx);
	assert.equal(attempts.at(-1).selected, fallback, "use openai when codex auth is missing");
	ctx.modelRegistry.hasConfiguredAuth = () => true;

	attempts.length = 0;
	complete = async () => response("Cancelled", "aborted");
	await assert.rejects(command("", ctx), /Cancelled/);
	assert.equal(attempts.length, 1, "cancellation must not invoke openai");

	attempts.length = 0;
	complete = async () => { throw new DOMException("Cancelled", "AbortError"); };
	await assert.rejects(command("", ctx), /Cancelled/);
	assert.equal(attempts.length, 1);

	attempts.length = 0;
	complete = async () => response("Provider unavailable", "error");
	await assert.rejects(command("", ctx), /Provider unavailable/);
	assert.deepEqual(attempts.map((a) => a.selected), [model, fallback]);

	// An explicit list replaces the defaults, retains model IDs containing slashes,
	// and is reread without restarting Pi.
	writeFileSync(configPath, JSON.stringify({ models: ["openrouter/anthropic/custom-model", "openai/gpt-6-luna"] }));
	attempts.length = 0;
	complete = async (_options, selected) => selected === custom
		? response("Custom unavailable", "error") : response("Configured fallback");
	await command("", ctx);
	assert.deepEqual(attempts.map((a) => a.selected), [custom, fallback]);

	writeFileSync(configPath, JSON.stringify({ models: ["openrouter/anthropic/custom-model"] }));
	attempts.length = 0;
	await assert.rejects(command("", ctx), /Custom unavailable/);
	assert.deepEqual(attempts.map((a) => a.selected), [custom], "must not add default providers to a custom list");

	ctx.modelRegistry.hasConfiguredAuth = () => false;
	await assert.rejects(command("", ctx), /No authenticated wut model/);
	ctx.modelRegistry.hasConfiguredAuth = () => true;
	writeFileSync(configPath, JSON.stringify({ models: ["missing/model"] }));
	await assert.rejects(command("", ctx), /No authenticated wut model/);
	writeFileSync(configPath, "{");
	await assert.rejects(command("", ctx), /wut\.json/);
	for (const invalid of ['{}', '{"models":[]}', '{"models":["no-provider"]}', '{"models":[1]}', '{"models":["openai/x"],"typo":true}']) {
		writeFileSync(configPath, invalid);
		await assert.rejects(command("", ctx), /wut\.json/);
	}
	rmSync(configPath);
	symlinkSync(configPath, configPath);
	attempts.length = 0;
	await assert.rejects(command("", ctx), /ELOOP/);
	assert.equal(attempts.length, 0, "an unreadable explicit configuration must not select default providers");
	rmSync(configPath);

	const longTool = (id, command) => handlers.get("tool_execution_start")({ toolCallId: id, toolName: "bash", args: { command } }, ctx);
	const toolSteps = (count = 3) => {
		for (let i = 0; i < count; i++) {
			longTool(`step-${i}`, "echo step");
			handlers.get("tool_execution_end")({ toolCallId: `step-${i}` }, ctx);
		}
	};
	// Cancel while the provider is answering: a stale STUCK result must never steer the agent.
	for (const cancel of ["off", "input", "agent_settled", "session_shutdown"]) {
		await command("auto on", ctx);
		await handlers.get("input")({ source: "interactive" }, ctx);
		await handlers.get("agent_start")({}, ctx);
		now += 16 * 60_000;
		toolSteps();
		const deferred = Promise.withResolvers();
		complete = () => deferred.promise;
		const before = attempts.length;
		const checking = tick();
		assert.equal(attempts.length, before + 1, "watchdog did not consult the provider");
		if (cancel === "off") await command("auto off", ctx);
		else await handlers.get(cancel)({ source: "interactive" }, ctx);
		deferred.resolve(response("STUCK: repeating the failed command"));
		await checking;
		assert.equal(sent.length, 0, `steered after ${cancel}`);
		assert.equal(attempts.length, before + 1, `fallback request after ${cancel}`);
	}
	// A tool call that blocks the agent and looks hung is interrupted; the note follows once the run settles.
	await command("auto on", ctx);
	const observe = async (text) => {
		complete = async () => response(text);
		const before = attempts.length;
		await tick();
		assert.equal(attempts.length, before + 1, "watchdog did not consult the provider");
		return attempts.at(-1).request.messages[0].content[0].text;
	};
	await handlers.get("input")({ source: "interactive" }, ctx);
	await handlers.get("agent_start")({}, ctx);
	longTool("wait", "until curl -s localhost/status | grep ready; do sleep 5; done");
	now += 60_000;
	handlers.get("tool_execution_update")({ toolCallId: "wait", partialResult: { content: [{ type: "text", text: "status: cancelled" }] } }, ctx);
	now += 15 * 60_000;
	const watched = await observe("HUNG: polling a cancelled build that will never be ready");
	for (const expected of ["until curl", "running for 16 min", "last output 15 min ago", "status: cancelled"]) {
		assert.ok(watched.includes(expected), expected);
	}
	assert.equal(aborts, 1, "a hung blocking call must be interrupted");
	assert.equal(sent.length, 0, "the note must wait until the interrupted run settles, not join its queue");
	await handlers.get("agent_settled")({ aborted: true }, ctx);
	assert.equal(sent.length, 1);
	assert.equal(sent[0][1]?.deliverAs, undefined, "the note starts a new run rather than queueing");
	assert.match(sent[0][0], /^<wut_watchdog> wut interrupted you: you had been blocked for 16 min on:\nbash: .*until curl/);
	assert.match(sent[0][0], /cancelled build/);

	// One interrupt per real user message; a later STUCK verdict waits for the blocking call to return.
	await handlers.get("agent_start")({}, ctx);
	longTool("sleep", "sleep 1800");
	now += 11 * 60_000;
	await observe("HUNG: still sleeping");
	assert.equal(aborts, 1, "interrupted twice for one user message");
	assert.match(notices.at(-1), /not interrupting again/);
	now += 11 * 60_000;
	toolSteps();
	await observe("STUCK: retrying the same sleep");
	assert.equal(sent.length, 1, "a steer queued behind a blocking call could only land when it returns");
	assert.match(notices.at(-1), /when its current tool call returns/);
	handlers.get("tool_execution_end")({ toolCallId: "sleep" }, ctx);
	assert.equal(sent.length, 2);
	assert.match(sent[1][0], /^<wut_watchdog> A friendly observer.*retrying the same sleep/);
	assert.deepEqual(sent[1][1], { deliverAs: "steer" });

	// HUNG without a long blocking call is a loop, so it steers at once.
	now += 11 * 60_000;
	toolSteps();
	await observe("HUNG: nothing is running");
	assert.equal(aborts, 1);
	assert.equal(sent.length, 3);
	assert.deepEqual(sent[2][1], { deliverAs: "steer" });

	// The user typing after an interrupt replaces the pending note.
	await handlers.get("input")({ source: "interactive" }, ctx);
	await handlers.get("agent_start")({}, ctx);
	longTool("hang", "npm run dev");
	now += 16 * 60_000;
	await observe("HUNG: a dev server never exits");
	assert.equal(aborts, 2, "a new user message allows a new interrupt");
	await handlers.get("input")({ source: "interactive" }, ctx);
	await handlers.get("agent_settled")({ aborted: true }, ctx);
	assert.equal(sent.length, 3, "sent a stale interrupt note after the user spoke");
	// Turning auto off drops either kind of pending message, not just an in-flight observation.
	for (const verdict of ["STUCK", "HUNG"]) {
		await command("auto on", ctx);
		await handlers.get("input")({ source: "interactive" }, ctx);
		await handlers.get("agent_start")({}, ctx);
		longTool("pending", "sleep 1800");
		now += 16 * 60_000;
		toolSteps();
		await observe(`${verdict}: waiting too long`);
		const sentBeforeOff = sent.length;
		await command("auto off", ctx);
		handlers.get("tool_execution_end")({ toolCallId: "pending" }, ctx);
		await handlers.get("agent_settled")({ aborted: verdict === "HUNG" }, ctx);
		assert.equal(sent.length, sentBeforeOff, `delivered a pending ${verdict} message after auto off`);
	}
	// A blocking-call check still needs three completed tool calls to prod.
	await command("auto on", ctx);
	for (const events of [0, 2]) {
		await handlers.get("input")({ source: "interactive" }, ctx);
		await handlers.get("agent_start")({}, ctx);
		longTool("blocked", "npm test");
		now += 16 * 60_000;
		toolSteps(events);
		const sentBeforeEvents = sent.length;
		await observe("STUCK: waiting on the same test");
		handlers.get("tool_execution_end")({ toolCallId: "blocked" }, ctx);
		assert.equal(sent.length, sentBeforeEvents, `prodded with only ${events} tool events`);
	}

	// Interrupts and prods follow their own rules: a hung call is interrupted after 10 minutes even
	// early in the task, a held prod does not delay that interrupt, and a check made for a blocking
	// call cannot prod before the task has run 15 minutes.
	await command("auto on", ctx);
	const sentBeforeEarly = sent.length;
	await handlers.get("input")({ source: "interactive" }, ctx);
	await handlers.get("agent_start")({}, ctx);
	longTool("early", "sleep 1800");
	now += 11 * 60_000;
	toolSteps();
	await observe("STUCK: sleeping instead of working");
	handlers.get("tool_execution_end")({ toolCallId: "early" }, ctx);
	assert.equal(sent.length, sentBeforeEarly, "prodded before the agent had run 15 minutes");
	await handlers.get("input")({ source: "interactive" }, ctx);
	await handlers.get("agent_start")({}, ctx);
	longTool("early-2", "sleep 1800");
	now += 11 * 60_000;
	const abortsBefore = aborts;
	await observe("HUNG: sleeping for half an hour");
	assert.equal(aborts, abortsBefore + 1, "the 15-minute prod gate delayed an interrupt");
	await handlers.get("agent_settled")({ aborted: true }, ctx);

	await handlers.get("input")({ source: "interactive" }, ctx);
	await handlers.get("agent_start")({}, ctx);
	longTool("slow", "npm test");
	now += 16 * 60_000;
	toolSteps();
	await observe("STUCK: rerunning the same step");
	assert.match(notices.at(-1), /when its current tool call returns/);
	now += 3 * 60_000;
	await observe("HUNG: the test runner is waiting on a closed socket");
	assert.equal(aborts, abortsBefore + 2, "a held prod delayed the interrupt through its cooldown");
	await handlers.get("agent_settled")({ aborted: true }, ctx);
	assert.match(sent.at(-1)[0], /^<wut_watchdog> wut interrupted/);
	assert.equal(sent.filter(([text]) => text.includes("rerunning the same step")).length, 0, "the interrupt should replace the held prod");
	await handlers.get("session_shutdown")({}, ctx);
	assert.equal(intervals.size, 0, "session shutdown left the watchdog running");
	console.log("ok");
} finally {
	Date.now = originals.now;
	globalThis.setInterval = originals.setInterval;
	globalThis.clearInterval = originals.clearInterval;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(scratch, { recursive: true, force: true });
}
