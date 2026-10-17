// Exercise the registered command/events; only the provider and clock are replaced.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
let observed;
let observedModel;
let requests = 0;
const model = { provider: "openai-codex", id: "gpt-6-luna" };
const fallback = { provider: "openai", id: "gpt-6-luna" };
const custom = { provider: "openrouter", id: "anthropic/custom-model" };
const attempts = [];
const branch = [];
const ctx = {
	mode: "rpc", hasUI: true, model: { provider: "anthropic", id: "test-session" }, isIdle: () => false,
	ui: { notify: (text) => notices.push(text) },
	sessionManager: { getBranch: () => branch },
	modelRegistry: {
		find: (provider, id) => [model, fallback, custom].find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
		complete: async (selected, request, options) => {
			requests++;
			attempts.push({ selected, request, options });
			observedModel = selected;
			observed = request;
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
	assert.equal(observedModel, model, "wut should prefer openai-codex/gpt-6-luna");
	const prompt = observed.messages[0].content[0].text;
	for (const expected of ["Fix the import", "Checking dependencies", "Agent ran tool bash", "(FAILED)", "Missing module", "old import path"]) {
		assert.ok(prompt.includes(expected), expected);
	}
	assert.match(prompt, /last message \(the goal\):\nFix the import/);
	assert.equal(notices.at(-1), "A short update");

	ctx.modelRegistry.hasConfiguredAuth = () => false;
	await command("", ctx);
	assert.equal(observedModel, ctx.model, "wut should keep the session-model fallback without observer auth");
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
		assert.deepEqual(attempts[0].options, attempts[1].options);
	}

	ctx.modelRegistry.hasConfiguredAuth = (selected) => selected === fallback;
	await command("", ctx);
	assert.equal(observedModel, fallback, "use openai when codex auth is missing");
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
	for (const invalid of ['{', '{}', '{"models":[]}', '{"models":["no-provider"]}', '{"models":[1]}', '{"models":["openai/x"],"typo":true}']) {
		writeFileSync(configPath, invalid);
		await assert.rejects(command("", ctx), /wut\.json/);
	}
	rmSync(configPath);

	// Cancel while the provider is answering: a stale STUCK result must never steer the agent.
	for (const cancel of ["off", "input", "agent_settled", "session_shutdown"]) {
		await command("auto on", ctx);
		await handlers.get("input")({ source: "interactive" }, ctx);
		await handlers.get("agent_start")({}, ctx);
		now += 16 * 60_000;
		for (let i = 0; i < 3; i++) handlers.get("tool_execution_end")({ toolCallId: `${i}` }, ctx);
		const deferred = Promise.withResolvers();
		complete = () => deferred.promise;
		const before = requests;
		const checking = tick();
		assert.equal(requests, before + 1, "watchdog did not consult the provider");
		if (cancel === "off") await command("auto off", ctx);
		else await handlers.get(cancel)({ source: "interactive" }, ctx);
		deferred.resolve(response("STUCK: repeating the failed command"));
		await checking;
		assert.equal(sent.length, 0, `steered after ${cancel}`);
		assert.equal(requests, before + 1, `fallback request after ${cancel}`);
	}
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
