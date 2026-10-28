// Explicit live test: npx jiti tests/wut_acceptance.mjs /absolute/scratch/evidence
// Uses a real approved model and a disposable local failure endpoint. Not part of CI.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Type } from "typebox";
import { createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import wut from "../extensions/wut.ts";

const evidence = process.argv[2];
assert(evidence && path.isAbsolute(evidence), "Supply an absolute scratch evidence directory");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(evidence, "workspace-"));
const config = path.join(getAgentDir(), "wut.json");
assert(!fs.existsSync(config), "Use a scratch agent directory without personal wut settings");
const events = [];
const record = (event) => { events.push(event); fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 }); };
let failedRequests = 0;
const stub = http.createServer((request, response) => {
	failedRequests++;
	request.resume();
	response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Synthetic observer failure" } }));
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const runtime = await ModelRuntime.create();
const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
assert(model);
record({ type: "model", provider: model.provider, model: model.id, thinking: "medium", observerThinking: "low", revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() });
const ambient = SettingsManager.create(cwd, getAgentDir()).getSettings();
const settingsManager = SettingsManager.inMemory({ ...ambient,
	packages: (ambient.packages ?? []).map((entry) => ({ ...(typeof entry === "string" ? { source: entry } : entry), extensions: ["**/*", "-extensions/wut.ts"] })),
});
let command;
const results = new Map();
const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager, extensionFactories: [
	createCodemodeExtension(), createToolSearchExtension(), createMcpExtension(),
	async (pi) => {
		await wut(new Proxy(pi, { get(target, key) {
			if (key === "registerCommand") return (name, definition) => { if (name === "wut") command = definition.handler; target.registerCommand(name, definition); };
			return Reflect.get(target, key);
		} }));
	},
	(pi) => {
		pi.registerProvider("wut-failure-test", { baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, api: "openai-completions", apiKey: "test",
			models: [{ id: "unavailable", name: "Synthetic failure", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }] });
		pi.registerTool({ name: "wut_refactor_probe", label: "Wut acceptance", description: "Exercise the real wut command using isolated test settings.",
			parameters: Type.Object({ scenario: Type.Union([Type.Literal("explicit"), Type.Literal("fallback"), Type.Literal("unreadable"), Type.Literal("invalid")]) }),
			async execute(_id, { scenario }, _signal, _update, ctx) {
				assert(command);
				fs.rmSync(config, { force: true });
				if (scenario === "unreadable") fs.symlinkSync(config, config);
				else if (scenario === "invalid") fs.writeFileSync(config, "{");
				else fs.writeFileSync(config, JSON.stringify({ models: scenario === "fallback" ? ["wut-failure-test/unavailable", "openai-codex/gpt-6.1-sol", "openai-codex/gpt-6.1-sol"] : ["openai-codex/gpt-6.1-sol"] }));
				const attempts = [];
				let answer;
				const registry = new Proxy(ctx.modelRegistry, { get(target, key) {
					if (key === "complete") return async (selected, request, options) => {
						attempts.push(`${selected.provider}/${selected.id}`);
						const response = await target.complete(selected, request, options);
						record({ type: "observer_response", scenario, provider: response.provider, model: response.model, stopReason: response.stopReason });
						return response;
					};
					const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
				} });
				try {
					await command("Explain the synthetic file task and its current progress.", { ...ctx, mode: "rpc", hasUI: true, modelRegistry: registry, ui: { ...ctx.ui, notify: (text) => { answer = text; } } });
					assert(!["unreadable", "invalid"].includes(scenario), "invalid settings unexpectedly reached a provider");
					assert(answer?.trim());
					assert.deepEqual(attempts, scenario === "fallback" ? ["wut-failure-test/unavailable", "openai-codex/gpt-6.1-sol"] : ["openai-codex/gpt-6.1-sol"]);
				} catch (error) {
					if (!["unreadable", "invalid"].includes(scenario)) throw error;
					assert.match(error.message, scenario === "unreadable" ? /ELOOP/ : /wut\.json/);
					assert.equal(attempts.length, 0);
					answer = "Configuration rejected before any provider request";
				} finally { fs.rmSync(config, { force: true }); }
				const result = { scenario, attempts, answer };
				results.set(scenario, result); record({ type: "probe", ...result });
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});
	},
] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, resourceLoader: loader, settingsManager, modelRuntime: runtime, model, thinkingLevel: "medium", sessionManager: SessionManager.create(cwd, path.join(evidence, "sessions")) });
await session.bindExtensions({ onError: (error) => record({ type: "extension_error", message: error.message }) });
session.subscribe((event) => { if (event.type === "tool_execution_start") record({ type: event.type, name: event.toolName, args: event.args }); });
const prompt = `Work only in ${cwd}. This is a synthetic acceptance test. Write proof.txt containing exactly WUT-ACCEPTANCE, then read it back with a tool. Call wut_refactor_probe once for each scenario in this order: explicit, fallback, unreadable, invalid. The probe manages only disposable test settings. Do not edit settings yourself or call other model providers. Finish with ACCEPTANCE DONE.`;
fs.writeFileSync(path.join(evidence, "prompt.txt"), prompt);
try {
	await session.prompt(prompt); await session.waitForIdle();
	assert.equal(fs.readFileSync(path.join(cwd, "proof.txt"), "utf8").trim(), "WUT-ACCEPTANCE");
	assert.deepEqual([...results.keys()], ["explicit", "fallback", "unreadable", "invalid"]);
	assert(failedRequests > 0, "the failed provider was actually called");
	assert(events.some((event) => event.type === "observer_response" && event.provider === "openai-codex" && event.model === "gpt-6.1-sol" && event.stopReason === "stop"));
	record({ type: "passed", failedRequests });
} finally { await session.abort(); session.dispose(); stub.close(); fs.rmSync(config, { force: true }); }
console.log(JSON.stringify({ passed: true, evidence }));
process.exit(0);
