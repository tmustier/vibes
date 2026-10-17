// Hermetic real-Pi lifecycle/configuration integration. All model HTTP is fixture SSE.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibes-gzip-integration-"));
process.env.PI_CODING_AGENT_DIR = scratch;
const originalFetch = globalThis.fetch;
const requests = [];
let rejectGzip = false;
const fixtureFetch = async (input, init) => {
	const url = new URL(String(input));
	assert.equal(url.pathname, "/v1/messages", "Unexpected network request");
	assert(["api.anthropic.com", "legacy-override.invalid", "config.invalid"].includes(url.hostname));
	const headers = new Headers(init.headers);
	const gzip = headers.get("content-encoding") === "gzip";
	const payload = JSON.parse(gzip ? gunzipSync(init.body).toString("utf8") : init.body);
	requests.push({ url: url.href, gzip, payload, headers });
	if (gzip && rejectGzip) return new Response("unsupported encoding", { status: 415 });
	const message = { id: "msg_fixture", type: "message", role: "assistant", model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } };
	const events = [
		{ type: "message_start", message },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", "request-id": "req_fixture" } });
};
globalThis.fetch = fixtureFetch;
const { createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
const { default: registerGzip } = await import("../packages/pi-anthropic-gzip/index.ts");
const { fastMode } = await import("../extensions/fast-mode.ts");
initTheme("dark", false);
const modelsPath = path.join(scratch, "models.json");
const config = { providers: { anthropic: { baseUrl: "https://config.invalid", modelOverrides: { "claude-opus-4-6": { maxTokens: 77 } } } } };
fs.writeFileSync(modelsPath, JSON.stringify(config));
fs.writeFileSync(path.join(scratch, "fast-mode.json"), JSON.stringify({ mode: "fast" }));
const credentials = new InMemoryCredentialStore();
await credentials.modify("anthropic", async () => ({ type: "oauth", access: "sk-ant-oat01-fixture", refresh: "fixture", expires: Date.now() + 3600000 }));
const runtime = await ModelRuntime.create({ credentials, modelsPath, allowModelNetwork: false });
let enabled = true;
let legacy = false;
let session;
try {
	for (const order of ["gzip-first", "gzip-last"]) {
		fs.writeFileSync(modelsPath, JSON.stringify(config));
		await runtime.refresh({ allowNetwork: false });
		// Representative pi-oauth registration/hook; the explicit live test loads the actual package.
		const oauthFixture = (pi) => {
			pi.registerProvider("anthropic", { baseUrl: legacy ? "https://legacy-override.invalid" : "https://api.anthropic.com" });
			pi.on("before_provider_request", (event) => {
				const payload = event.payload;
				return { ...payload, system: payload.system?.slice(0, 1), messages: [{ role: "user", content: [{ type: "text", text: `<system-reminder>${payload.system?.map((block) => block.text).join("\n")}</system-reminder>` }] }, ...payload.messages] };
			});
			pi.on("before_provider_headers", (event) => { event.headers["x-gzip-fixture"] = "preserved"; });
		};
		const gzipFactory = (pi) => { if (enabled) registerGzip(pi); };
		const others = [(pi) => fastMode(pi), oauthFixture];
		const loader = new DefaultResourceLoader({ cwd: scratch, agentDir: scratch, noContextFiles: true, systemPrompt: "Synthetic context. ".repeat(400), settingsManager: SettingsManager.inMemory(), extensionFactories: order === "gzip-first" ? [gzipFactory, ...others] : [...others, gzipFactory] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const model = runtime.getModel("anthropic", "claude-opus-4-6");
		({ session } = await createAgentSession({ cwd: scratch, resourceLoader: loader, modelRuntime: runtime, model, thinkingLevel: "off", sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory() }));
		await session.bindExtensions({ onError: (error) => { throw error; } });
		assert.equal(runtime.getModel("anthropic", model.id).baseUrl, "https://api.anthropic.com", "Legacy endpoint must still beat models.json");
		assert.equal(runtime.getModel("anthropic", model.id).maxTokens, 77);
		const dispatcher = globalThis.fetch;
		await session.bindExtensions({});
		assert.equal(globalThis.fetch, dispatcher);
		await session.prompt("Reply OK.");
		const first = requests.at(-1);
		assert(first.gzip);
		assert.equal(first.payload.speed, "fast", "Real fast-mode must survive");
		assert(first.payload.messages[0].content[0].text.startsWith("<system-reminder>"));
		assert(first.headers.get("anthropic-beta").includes("fast-mode-2026-02-01"));
		assert.equal(first.headers.get("x-gzip-fixture"), "preserved");
		assert.equal(session.getLastAssistantText(), "OK");

		// A removed model setting must disappear immediately on refresh, not get baked into a decorator.
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { baseUrl: "https://config.invalid" } } }));
		await runtime.refresh({ allowNetwork: false });
		assert.notEqual(runtime.getModel("anthropic", model.id).maxTokens, 77);
		assert.equal(runtime.getModel("anthropic", model.id).baseUrl, "https://api.anthropic.com");

		for (let n = 0; n < 2; n++) {
			await session.reload();
			assert.equal(globalThis.fetch, dispatcher, "Reload must reuse the stable fetch dispatcher");
			await session.prompt("Reply OK."); assert(requests.at(-1).gzip);
			assert.equal(requests.at(-1).payload.speed, "fast", "Reload must use the active new fast-mode instance");
		}
		// Endpoint override passes through, even while compression is enabled.
		legacy = true; await session.reload();
		await session.prompt("Reply OK.");
		assert.equal(requests.at(-1).gzip, false);
		assert(requests.at(-1).url.startsWith("https://legacy-override.invalid/"));
		legacy = false; await session.reload();
		// Rejection retries identity once, then later requests remain plain until reload.
		rejectGzip = true;
		const count = requests.length;
		await session.prompt("Reply OK.");
		assert.deepEqual(requests.slice(count).map((r) => r.gzip), [true, false]);
		await session.prompt("Reply OK."); assert.equal(requests.at(-1).gzip, false);
		rejectGzip = false;
		enabled = false; await session.reload();
		assert.equal(globalThis.fetch, fixtureFetch);
		await session.prompt("Reply OK."); assert.equal(requests.at(-1).gzip, false);
		assert.equal(requests.at(-1).payload.speed, "fast");
		enabled = true; await session.reload();
		await session.prompt("Reply OK."); assert(requests.at(-1).gzip);
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await session.dispose(); session = undefined;
		assert.equal(globalThis.fetch, fixtureFetch);
	}
	console.log("PASS: real Pi sessions in both load orders; fast mode, OAuth-style payload/headers and legacy endpoint precedence; config removal/refresh; repeated bind/reload, fallback, disable/re-enable and shutdown");
} finally {
	await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	await session?.dispose();
	globalThis.fetch = originalFetch;
	fs.rmSync(scratch, { recursive: true, force: true });
}
