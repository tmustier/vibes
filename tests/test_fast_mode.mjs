import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "vibes-fast-test-"));
process.env.PI_CODING_AGENT_DIR = scratch;
const { fastMode } = await import("../extensions/fast-mode.ts");
const astra = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6-astra" };
const sol = { ...astra, id: "gpt-6.1-sol" };
const opus46 = { provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-6" };
const configPath = join(scratch, "fast-mode.json");
const saved = () => JSON.parse(readFileSync(configPath));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function harness(model = astra, config = { mode: "off" }, existingCommands = []) {
	writeFileSync(configPath, typeof config === "string" ? config : JSON.stringify(config));
	const events = new Map();
	const commands = new Map(existingCommands.map((name) => [name, {}]));
	const providers = new Map();
	const streams = [];
	const notices = [];
	const statuses = [];
	const menus = [];
	const bus = new Map();
	const entries = [];
	fastMode({
		appendEntry: (customType, data) => entries.push({ customType, data }),
		getCommands: () => [...commands.keys()].map((name) => ({ name, source: "extension" })),
		events: {
			on: (name, handler) => { bus.set(name, handler); return () => bus.delete(name); },
			emit: (_name, data) => menus.push(data),
		},
		on: (name, handler) => { const previous = events.get(name); events.set(name, previous ? (event, ctx) => { previous(event, ctx); return handler(event, ctx); } : handler); },
		registerCommand: (name, options) => { assert(!commands.has(name)); commands.set(name, options); },
		registerProvider: (name, config) => providers.set(name, config),
	}, (model, context, options) => { streams.push({ model, context, options }); return "stream"; });
	const ctx = {
		model,
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (_key, value) => statuses.push(value),
			notify: (message, type) => notices.push({ message, type }),
		},
	};
	events.get("session_start")({}, ctx);
	return {
		events, ctx, notices, statuses, menus, bus, providers, streams, entries,
		run: (args) => commands.get("fast").handler(args, ctx),
		/** Send a request through the provider layer and return the body the provider would see. */
		request: async (payload = { model: ctx.model.id }, model = ctx.model, options = { onPayload: async (body) => body }) => {
			assert.equal(providers.get(model.provider).streamSimple(model, "context", options), "stream");
			return streams.at(-1).options.onPayload(payload, model);
		},
		headers: (headers) => { events.get("before_provider_headers")({ headers }, ctx); return headers; },
		/** Finish an assistant message and return the message Pi would save. */
		finish: (message) => events.get("message_end")?.({ message }, ctx)?.message ?? message,
	};
}

test("layers every fast provider and passes other requests through untouched", async () => {
	const h = harness(astra, { mode: "ultrafast" });
	const options = { apiKey: "k", onPayload: async (body) => ({ ...body, seen: true }) };
	assert.deepEqual(await h.request({ model: astra.id }, astra, options), { model: astra.id, seen: true, service_tier: "ultrafast" });
	assert.equal(h.streams.at(-1).options.apiKey, "k");
	assert.equal(h.streams.at(-1).context, "context");
	const plain = { ...sol, id: "gpt-6-sol" };
	assert.deepEqual(await h.request({ model: plain.id }, plain, options), { model: plain.id, seen: true });
	assert.equal(h.streams.at(-1).options, options);
	assert.equal(await h.request(undefined, astra, { onPayload: async (body) => ({ ...body, service_tier: "priority" }) }).then((b) => b.service_tier), "ultrafast", "a chat-loop hook cannot overwrite the tier");
	assert.equal(await h.request(undefined, astra, {}).then((b) => b.service_tier), "ultrafast", "works without a chat-loop hook");
});

test("commands toggle, select and persist modes on both OpenAI transports", async () => {
	for (const api of ["openai-responses", "openai-codex-responses"]) {
		const h = harness({ ...astra, api, provider: api === "openai-responses" ? "openai" : "openai-codex" });
		for (const [command, tier] of [["", "priority"], ["", undefined], ["ultrafast", "ultrafast"], [" ON ", "priority"], ["off", undefined]]) {
			await h.run(command);
			assert.equal((await h.request()).service_tier, tier);
			assert.equal(saved().enabled, tier !== undefined);
		}
		const before = readFileSync(configPath, "utf8");
		await h.run("status");
		assert.match(h.notices.at(-1).message, /Fast mode: off/);
		await h.run("on extra");
		assert.match(h.notices.at(-1).message, /Usage:/);
		assert.equal(readFileSync(configPath, "utf8"), before);
	}
});

test("compaction runs at its own speed, never slower than the turns, only inside the compaction window", async () => {
	const h = harness(sol, { mode: "off" });
	const during = async (model) => {
		h.events.get("session_before_compact")({}, h.ctx);
		const body = await h.request(undefined, model);
		h.events.get("session_compact")({ compactionEntry: { id: "compaction" } }, h.ctx);
		return body.service_tier;
	};
	assert.equal(await during(), "priority", "compaction is fast by default while turns are off");
	assert.equal((await h.request()).service_tier, undefined, "turn requests stay at the turn speed");
	await h.run("status");
	assert.match(h.notices.at(-1).message, /Fast mode: off\.\nCompaction: fast \(default\)\.[\s\S]*Request patch: inactive\nCompaction patch: service_tier=priority/);
	await h.run("compaction ultrafast");
	assert.equal(saved().compaction, "ultrafast");
	assert.equal(await during(), "ultrafast");
	assert.equal(await during({ ...sol, id: "gpt-6-sol" }), "priority", "a model without the speed gets the fastest it has");
	assert.equal(await during({ provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5" }), undefined);
	assert.equal((await h.request()).service_tier, undefined);
	h.events.get("session_before_compact")({}, h.ctx);
	h.events.get("session_compact_failed")({}, h.ctx);
	assert.equal((await h.request()).service_tier, undefined, "a failed compaction closes the window");
	await h.run("compaction off");
	assert.equal(await during(), undefined);
	await h.run("status");
	assert.match(h.notices.at(-1).message, /Compaction: off\.[\s\S]*Compaction patch: inactive/);
	await h.run("ultrafast");
	assert.equal(await during(), "ultrafast", "faster turns raise compaction");
	await h.run("status");
	assert.match(h.notices.at(-1).message, /Compaction: off, raised to ultrafast by fast mode\./);
	await h.run("fast");
	await h.run("compaction default");
	assert.equal(saved().compaction, undefined);
	assert.equal(await during(), "priority");
	await h.run("status");
	assert.match(h.notices.at(-1).message, /Compaction: fast \(default\)\./);
	await h.run("compaction sideways");
	assert.match(h.notices.at(-1).message, /Usage:/);
	await h.run("compaction");
	assert.match(h.notices.at(-1).message, /Usage:/);
});

test("the layer goes inert at shutdown so a reloaded instance owns the speed", async () => {
	const h = harness(astra, { mode: "ultrafast" });
	assert.equal((await h.request()).service_tier, "ultrafast");
	h.events.get("session_shutdown")({}, h.ctx);
	assert.equal((await h.request()).service_tier, undefined);
});

test("saved booleans migrate, explicit mode wins, and malformed config is preserved", async () => {
	for (const [config, tier] of [[{ enabled: true }, "priority"], [{ enabled: false }, undefined], [{ mode: "ultrafast", enabled: false }, "ultrafast"]]) {
		assert.equal((await harness(astra, config).request()).service_tier, tier);
	}
	for (const invalid of ["broken-json", "null", "[]", JSON.stringify({ mode: null }), JSON.stringify({ mode: "unknown" }), JSON.stringify({ mode: "fast", compaction: "warp" })]) {
		const h = harness(astra, invalid);
		assert.equal((await h.request()).service_tier, undefined);
		assert.match(h.notices[0].message, /Could not read/);
		assert.equal(readFileSync(configPath, "utf8"), invalid);
	}
});

test("Ultrafast gates on the model each request is sent to, not the selected model", async () => {
	const h = harness(astra, { mode: "ultrafast" });
	const plain = { ...astra, id: "gpt-6-sol" };
	const original = { model: plain.id, service_tier: "priority", input: ["hello"] };
	assert.equal(await h.request(original, plain), original);
	const patched = await h.request({ model: astra.id, service_tier: "priority", input: ["hello"] });
	assert.equal(patched.service_tier, "ultrafast");
	assert.deepEqual(patched.input, ["hello"]);
	h.ctx.model = plain;
	h.events.get("model_select")({}, h.ctx);
	assert.match(h.statuses.at(-1), /ultrafast n\/a/);
	assert.equal((await h.request({ model: astra.id }, astra)).service_tier, "ultrafast");
});

test("Sol supports Ultrafast requests and HUD controls on both OpenAI transports", async () => {
	for (const api of ["openai-responses", "openai-codex-responses"]) {
		const model = { ...sol, api, provider: api === "openai-responses" ? "openai" : "openai-codex" };
		const h = harness(model, { mode: "off" });
		await h.run("ultrafast");
		assert.equal(h.menus.at(-1).label, "↯ ultrafast");
		assert.equal((await h.request()).service_tier, "ultrafast");
		h.menus.at(-1).onClick();
		assert.equal((await h.request()).service_tier, undefined);
		h.menus.at(-1).onSelect("off");
		h.menus.at(-1).onSelect("ultrafast");
		assert.equal((await h.request()).service_tier, "ultrafast");
	}
});

test("HUD click cycles supported modes and stale controls cannot enable an unsupported mode", () => {
	const h = harness(astra, { mode: "ultrafast" });
	for (const mode of ["off", "fast", "ultrafast"]) {
		h.menus.at(-1).onClick();
		assert.equal(saved().mode, mode);
	}
	const staleSelect = h.menus.at(-1).onSelect;
	h.ctx.model = { ...astra, id: "gpt-6-sol" };
	h.events.get("model_select")({}, h.ctx);
	assert.equal(h.menus.at(-1).label, "ultrafast n/a");
	staleSelect("ultrafast");
	assert.match(h.notices.at(-1).message, /not supported by gpt-6-sol/);
	for (const mode of ["off", "fast", "off", "fast"]) {
		h.menus.at(-1).onClick();
		assert.equal(saved().mode, mode);
	}
	const staleClick = h.menus.at(-1).onClick;
	h.ctx.model = { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5-1" };
	h.events.get("model_select")({}, h.ctx);
	assert.equal(h.menus.at(-1).remove, true);
	staleClick();
	assert.equal(saved().mode, "fast");
});

test("menu selection preserves reported tiers, publishes on request and unsubscribes at shutdown", async () => {
	const h = harness();
	h.menus.at(-1).onSelect("ultrafast");
	assert.equal(h.menus.at(-1).label, "↯ ultrafast");
	const completed = { provider: astra.provider, model: astra.id, data: { type: "response.completed", response: { service_tier: "default" } } };
	h.events.get("provider_stream_event")({ ...completed, data: { ...completed.data, type: "response.created" } }, h.ctx);
	assert.doesNotMatch(h.statuses.at(-1), /reported:/);
	h.events.get("provider_stream_event")(completed, h.ctx);
	h.menus.at(-1).onSelect("ultrafast");
	assert.match(h.statuses.at(-1), /ultrafast \(reported: default\)/);
	await h.run("status");
	assert.match(h.notices.at(-1).message, /Last reported service tier: default/);
	h.events.get("provider_stream_event")({ ...completed, model: "gpt-6.1-sol", data: { ...completed.data, response: { service_tier: "ultrafast" } } }, h.ctx);
	assert.match(h.statuses.at(-1), /reported: default/);
	h.bus.get("pi-session-hud:chrome-menu-request:v1")();
	assert.equal(h.menus.at(-1).label, "↯ ultrafast");
	h.events.get("model_select")({}, h.ctx);
	assert.doesNotMatch(h.statuses.at(-1), /reported:/);
	await h.run("off");
	h.events.get("provider_stream_event")(completed, h.ctx);
	assert.equal(h.statuses.at(-1), undefined);
	h.events.get("session_shutdown")({}, h.ctx);
	assert.equal(h.bus.size, 0);
	assert.equal(h.menus.at(-1).remove, true);
});

test("existing /fast retains ownership; the provider layer stays inert without a loaded mode", async () => {
	const h = harness(astra, { mode: "ultrafast" }, ["fast"]);
	assert.match(h.notices[0].message, /existing \/fast command still owns/);
	assert.equal(h.menus.length, 0);
	assert.equal((await h.request()).service_tier, undefined);
	const reply = { role: "assistant", provider: astra.provider, model: astra.id, content: [] };
	assert.equal(h.finish(reply), reply);
});

test("Anthropic fast mode patches the body and beta header, and stops when disabled", async () => {
	const h = harness(opus46, { mode: "fast" });
	assert.equal((await h.request()).speed, "fast");
	assert.equal(h.headers({ "anthropic-beta": "existing-beta" })["anthropic-beta"], "existing-beta,fast-mode-2026-02-01");
	assert.equal(h.headers({ "anthropic-beta": "existing-beta,fast-mode-2026-02-01" })["anthropic-beta"], "existing-beta,fast-mode-2026-02-01");
	await h.run("ultrafast");
	assert.equal((await h.request()).speed, undefined);
	await h.run("off");
	assert.equal(h.headers({ "anthropic-beta": "existing-beta" })["anthropic-beta"], "existing-beta");
	h.ctx.model = { ...opus46, id: "claude-opus-5-5" };
	h.events.get("model_select")({}, h.ctx);
	await h.run("on");
	assert.equal((await h.request()).speed, undefined);
	assert.equal(h.headers({})["anthropic-beta"], undefined);
});

test("labels each response on a model with fast modes with the speed it was sent at", async () => {
	const h = harness(sol, { mode: "ultrafast" });
	const reply = (model = sol) => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], diagnostics: [{ type: "other", timestamp: 1 }] });
	const label = (message) => message.diagnostics?.filter(({ type }) => type === "vibes.speed").map(({ details }) => details.speed);
	await h.request();
	const saved = h.finish(reply());
	assert.deepEqual(label(saved), ["ultrafast"]);
	assert.equal(saved.diagnostics[0].type, "other", "existing diagnostics are kept");
	for (const [command, speed] of [["fast", "fast"], ["off", "standard"]]) {
		await h.run(command);
		await h.request();
		assert.deepEqual(label(h.finish(reply())), [speed]);
	}
	const fable = { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5-1" };
	await h.request(undefined, fable);
	assert.deepEqual(label(h.finish(reply(fable))), [], "models without fast modes stay unlabelled");
	const anthropic = harness(opus46, { mode: "fast" });
	await anthropic.request();
	assert.deepEqual(label(anthropic.finish(reply(opus46))), ["fast"]);
});

test("records each compaction's speed in an entry pointing at it, without touching turn labels", async () => {
	const h = harness(sol, { mode: "off", compaction: "ultrafast" });
	const reply = { role: "assistant", api: sol.api, provider: sol.provider, model: sol.id, content: [] };
	h.events.get("session_before_compact")({}, h.ctx);
	await h.request();
	await h.request();
	h.events.get("session_compact")({ compactionEntry: { id: "c1" } }, h.ctx);
	assert.deepEqual(h.entries, [{ customType: "vibes.speed", data: { targetId: "c1", provider: sol.provider, model: sol.id, speed: "ultrafast" } }]);
	await h.request();
	assert.deepEqual(h.finish(reply).diagnostics.map(({ details }) => details.speed), ["standard"], "turns resume at their own speed");
	h.events.get("session_before_compact")({}, h.ctx);
	await h.request();
	h.events.get("session_compact_failed")({}, h.ctx);
	h.events.get("session_before_compact")({}, h.ctx);
	h.events.get("session_compact")({ compactionEntry: { id: "c2" } }, h.ctx);
	assert.equal(h.entries.length, 1, "a compaction that sent nothing through the layer gets no entry");
	h.events.get("session_before_compact")({}, h.ctx);
	await h.request(undefined, { provider: "anthropic", api: "anthropic-messages", id: "claude-opus-5-5" });
	h.events.get("session_compact")({ compactionEntry: { id: "c3" } }, h.ctx);
	assert.equal(h.entries.length, 1, "compactions on models without fast modes get no entry");
});
