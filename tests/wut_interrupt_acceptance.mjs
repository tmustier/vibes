// Explicit live test: npx jiti tests/wut_interrupt_acceptance.mjs /absolute/scratch/evidence
// A real approved model blocks on a foreground poll that can never succeed; the real wut observer,
// with shortened timings, must interrupt it and the agent must continue from the note. Not part of CI.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createWut } from "../extensions/wut.ts";

const evidence = process.argv[2];
assert(evidence && path.isAbsolute(evidence), "Supply an absolute scratch evidence directory");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(evidence, "workspace-"));
assert(!fs.existsSync(path.join(getAgentDir(), "wut.json")), "Use an agent directory without personal wut settings");
const events = [];
const record = (event) => { events.push({ at: new Date().toISOString(), ...event }); fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 }); };

// The build reports progress twice, then is cancelled and never becomes ready.
let statusRequests = 0;
const stub = http.createServer((request, response) => {
	statusRequests++;
	request.resume();
	response.writeHead(200, { "content-type": "text/plain" }).end(statusRequests <= 2
		? "building: step 3 of 4\n"
		: "cancelled: build 4417 was cancelled by its owner and will not be retried\n");
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${stub.address().port}/status`;

const runtime = await ModelRuntime.create();
const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
assert(model);
const timing = { minRunMs: 10 * 60_000, tickMs: 2_000, checkIntervalMs: 5_000, longToolMs: 45_000, prodCooldownMs: 0 };
record({ type: "setup", provider: model.provider, model: model.id, thinking: "medium", observerThinking: "low", timing, revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "" });
const ambient = SettingsManager.create(cwd, getAgentDir()).getSettings();
const settingsManager = SettingsManager.inMemory({ ...ambient,
	packages: (ambient.packages ?? []).map((entry) => ({ ...(typeof entry === "string" ? { source: entry } : entry), extensions: ["**/*", "-extensions/wut.ts"] })),
});
const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager, extensionFactories: [
	// Record real observer verdicts and aborts without replacing their behaviour.
	(pi) => createWut(timing)({ ...pi, on(event, handler) {
		pi.on(event, event !== "agent_start" ? handler : (payload, ctx) => handler(payload, Object.create(ctx, {
			modelRegistry: { value: new Proxy(ctx.modelRegistry, { get(registry, key) {
				if (key === "complete") return async (selected, request, options) => {
					const response = await registry.complete(selected, request, options);
					record({ type: "observer", model: `${selected.provider}/${selected.id}`, stopReason: response.stopReason, answer: response.content.filter((b) => b.type === "text").map((b) => b.text).join("") });
					return response;
				};
				const value = Reflect.get(registry, key);
				return typeof value === "function" ? value.bind(registry) : value;
			} }) },
			abort: { value() { record({ type: "abort_requested" }); ctx.abort(); } },
		})));
	} }),
] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, resourceLoader: loader, settingsManager, modelRuntime: runtime, model, thinkingLevel: "medium", sessionManager: SessionManager.create(cwd, path.join(evidence, "sessions")) });
await session.bindExtensions({ onError: (error) => record({ type: "extension_error", extension: error.extensionPath, event: error.event, message: error.error }) });
session.subscribe((event) => {
	if (event.type === "tool_execution_start") record({ type: event.type, name: event.toolName, args: event.args });
	if (event.type === "tool_execution_end") record({ type: event.type, name: event.toolName, isError: event.isError });
	if (event.type === "agent_settled") record({ type: event.type, aborted: event.aborted });
	if (event.type === "message_end" && event.message.role === "user") record({ type: "user_message", text: event.message.content.filter?.((b) => b.type === "text").map((b) => b.text).join("") ?? event.message.content });
});
const prompt = `Work only in ${cwd}. The staging build reports its status at ${url}. Wait for it to report a line starting with "ready", then write its build id to build.txt. Check the status once, then wait in the foreground with exactly this bash command and no timeout: until curl -s ${url} | grep -q '^ready'; do curl -s ${url}; sleep 3; done`;
fs.writeFileSync(path.join(evidence, "prompt.txt"), prompt);
const settled = () => events.filter((e) => e.type === "agent_settled");
try {
	await session.prompt(prompt);
	const deadline = Date.now() + 10 * 60_000;
	while (!(settled().length >= 2 && session.isIdle) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1_000));
	await session.waitForIdle();

	const loop = events.find((e) => e.type === "tool_execution_start" && e.name === "bash" && String(e.args.command).startsWith("until"));
	assert(loop, "the agent never blocked on the poll");
	assert(events.some((e) => e.type === "observer" && /^HUNG\b/i.test(e.answer.trim())), "the observer never judged the call hung");
	assert.equal(events.filter((e) => e.type === "abort_requested").length, 1);
	assert.equal(settled()[0].aborted, true, "the first run did not end by interrupt");
	const note = events.find((e) => e.type === "user_message" && e.text.startsWith("<wut_watchdog> wut interrupted"));
	assert(note, "the interrupt note never reached the agent");
	assert(events.indexOf(note) > events.indexOf(settled()[0]), "the note arrived before the interrupted run settled");
	assert.equal(settled().at(-1).aborted, false, "the agent did not finish after the note");
	assert.equal(fs.existsSync(path.join(cwd, "build.txt")), false, "wrote a build id for a cancelled build");
	assert.equal(spawnSync("pgrep", ["-f", url], { encoding: "utf8" }).stdout.trim(), "", "the interrupted poll is still running");
} finally { await session.abort(); session.dispose(); stub.close(); }
const reply = session.messages.filter((m) => m.role === "assistant").at(-1);
record({ type: "passed", statusRequests, finalReply: reply?.content.filter((b) => b.type === "text").map((b) => b.text).join("") });
console.log(JSON.stringify({ passed: true, evidence }));
process.exit(0);
