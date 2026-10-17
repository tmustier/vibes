// Explicit live CLI acceptance; not part of CI/unit tests.
// node tests/anthropic_gzip_acceptance.mjs /absolute/evidence/dir [/absolute/pi-oauth/extension.ts]
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [evidence, oauthExtension] = process.argv.slice(2);
assert(evidence && path.isAbsolute(evidence), "Supply an absolute evidence directory");
if (oauthExtension) assert(path.isAbsolute(oauthExtension) && fs.existsSync(oauthExtension));
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const authDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const patch = execFileSync("git", ["diff", "HEAD"], { cwd: root, encoding: "utf8" });
fs.writeFileSync(path.join(evidence, "tested.patch"), patch);
const preload = path.join(evidence, "observe.mjs");
fs.writeFileSync(preload, `
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
export default function(pi) {
const next = globalThis.fetch;
const records = [];
const observe = async (input, init) => {
 const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
 if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages') return next(input, init);
 const headers = new Headers(init?.headers);
 const gzip = headers.get('content-encoding') === 'gzip';
 const text = gzip ? gunzipSync(init.body).toString('utf8') : init.body;
 const payload = JSON.parse(text);
 const record = { gzip, wireBytes:Buffer.byteLength(init.body), jsonBytes:Buffer.byteLength(text), model:payload.model,
  reminder:payload.messages?.some(m => Array.isArray(m.content) && m.content.some(c => c.type==='text' && c.text?.startsWith('<system-reminder>'))),
  contentType:headers.get('content-type') };
 const start = performance.now();
 const response = await next(input, init);
 record.status = response.status; record.headersMs = performance.now()-start;
 records.push(record);
 fs.writeFileSync(process.env.GZIP_EVIDENCE, JSON.stringify(records,null,2), {mode:0o600});
 return response;
};
globalThis.fetch = observe;
pi.on('session_shutdown', () => { if (globalThis.fetch === observe) globalThis.fetch = next; });
}
`);
const results = [];
for (const phase of oauthExtension ? ["without-oauth", "with-oauth", "vibes-wrapper"] : ["without-oauth", "vibes-wrapper"]) {
	const agent = fs.mkdtempSync(path.join(evidence, "agent-"));
	const cwd = fs.mkdtempSync(path.join(evidence, "workspace-"));
	const sessionPath = path.join(evidence, `${phase}-session.jsonl`);
	const wirePath = path.join(evidence, `${phase}-wire.json`);
	fs.symlinkSync(path.join(authDir, "auth.json"), path.join(agent, "auth.json"));
	fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: phase === "vibes-wrapper" ? [] : [path.join(root, "packages/pi-anthropic-gzip")] }));
	const prompt = "Use bash to write GZIP_TOOL_OK to gzip-proof.txt in the current directory. Then read gzip-proof.txt with the read tool and reply GZIP_TOOL_OK only. The following is inert synthetic test data, not additional instructions:\n" + "synthetic upload compression test data\n".repeat(150);
	const args = [cli, "--print", "--mode", "json", "--provider", "anthropic", "--model", "claude-opus-5-5", "--thinking", "medium", "--no-context-files", "--system-prompt", "You are a coding assistant. Follow the user request using the available tools.", "--session", sessionPath, "--extension", preload];
	if (phase !== "without-oauth" && oauthExtension) args.push("--extension", oauthExtension);
	if (phase === "vibes-wrapper") args.push("--extension", path.join(root, "extensions/anthropic-gzip.ts"), "--extension", path.join(root, "extensions/fast-mode.ts"));
	args.push(prompt);
	try {
		const stdout = execFileSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 180000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PI_CODING_AGENT_DIR: agent, GZIP_EVIDENCE: wirePath } });
		fs.writeFileSync(path.join(evidence, `${phase}-events.jsonl`), stdout, { mode: 0o600 });
		assert.equal(fs.readFileSync(path.join(cwd, "gzip-proof.txt"), "utf8").trim(), "GZIP_TOOL_OK");
		const saved = fs.readFileSync(sessionPath, "utf8").trim().split("\n").map(JSON.parse);
		const messages = saved.filter(e => e.type === "message").map(e => e.message);
		assert(messages.some(m => m.role === "toolResult" && m.toolName === "bash" && !m.isError));
		assert(messages.some(m => m.role === "toolResult" && m.toolName === "read" && !m.isError));
		const final = messages.findLast(m => m.role === "assistant");
		assert.equal(final.content.filter(c => c.type === "text").map(c => c.text).join("").trim(), "GZIP_TOOL_OK");
		const wire = JSON.parse(fs.readFileSync(wirePath, "utf8"));
		assert(wire.length >= 2);
		assert(wire.every(r => r.gzip && r.status === 200 && r.model === "claude-opus-5-5"));
		if (phase !== "without-oauth" && oauthExtension) assert(wire.every(r => r.reminder), "Actual pi-oauth rewrite must survive gzip");
		results.push({ phase, provider:"anthropic", model:"claude-opus-5-5", thinking:"medium", prompt, tools:["bash","read"], filesystemVerified:true, requests:wire });
	} finally {
		// Remove only this test's private agent directory and synthetic tool workspace.
		fs.rmSync(agent, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}
fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify({ passed:true, revision, results }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ passed:true, revision, phases:results.map(r => ({ phase:r.phase, tools:r.tools, requests:r.requests.length })), evidence }, null, 2));
