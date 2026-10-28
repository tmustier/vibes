import assert from "node:assert/strict";
import { mock } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import claudeArtifacts from "../lib/claude-artifacts/extension.ts";

const TOOL = "mcp__claude_artifacts__Artifact";
const uuid = "9c520471-a3d4-4fee-be90-98ccd65e8d63";

const usage = (...args) => spawnSync("python3", [path.resolve(import.meta.dirname, "../lib/claude-artifacts/artifact-api.py"), ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "unused" } });
assert.match(usage("delete", "LJaep3MewcVy4xEYAWvrCA").stderr, /expected an artifact UUID/, "the API deletes only a resolved UUID");
assert.match(usage("defs", "Bad Name").stderr, /invalid capability name/);

// A stand-in for `claude mcp serve`: it records each start and call, answers a page read with the
// file READ_PAGE names, and otherwise reports how it was started.
const claudeBin = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-bin-"));
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-cache-"));
const fakeClaude = path.join(claudeBin, "claude");
const tool = (name) => ({ name, description: `${name} from Claude Code`, inputSchema: { type: "object", properties: { action: { type: "string" } } }, annotations: { destructiveHint: true } });
fs.writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(claudeBin, "starts"))}, process.pid + " " + process.argv.slice(2).join(" ") + "\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let at; (at = buffer.indexOf("\\n")) >= 0; buffer = buffer.slice(at + 1)) {
		const { id, method, params } = JSON.parse(buffer.slice(0, at));
		if (method === "initialize" && !process.env.HANG_INITIALIZE) send({ id, result: {} });
		if (method === "tools/list") send({ id, result: { tools: [${JSON.stringify(tool("Artifact"))}, ...(process.env.SIGNED_OUT ? [] : [${JSON.stringify(tool("ArtifactComments"))}, ${JSON.stringify(tool("ArtifactData"))}]), { name: "Bash", description: "x", inputSchema: {} }] } });
		if (method === "tools/call" && params.arguments.action === "hang") continue;
		if (method === "tools/call") fs.appendFileSync(${JSON.stringify(path.join(claudeBin, "calls"))}, JSON.stringify(params) + "\\n");
		if (method === "tools/call" && params.arguments.action === "read" && process.env.READ_PAGE) send({ id, result: { content: [{ type: "text", text: fs.readFileSync(process.env.READ_PAGE, "utf8") }] } });
		else if (method === "tools/call") setTimeout(() => send({ id, result: { isError: params.arguments.action === "fail", content: [{ type: "text", text: JSON.stringify({ tool: params.name, args: params.arguments, cwd: process.cwd(), artifact: process.env.CLAUDE_CODE_ARTIFACT, nodeOptions: process.env.NODE_OPTIONS ?? null }) }] } }), params.arguments.action === "slow" ? 600 : 0);
	}
});
`, { mode: 0o755 });
const starts = () => fs.existsSync(path.join(claudeBin, "starts")) ? fs.readFileSync(path.join(claudeBin, "starts"), "utf8").trim().split("\n").map((line) => line.split(" ")) : [];
const claudeCalls = () => fs.existsSync(path.join(claudeBin, "calls")) ? fs.readFileSync(path.join(claudeBin, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const running = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const until = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20)); return check(); };

function load(options = {}) {
	const handlers = new Map();
	const tools = new Map();
	let active = ["read"];
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerTool: (definition) => tools.set(definition.name, definition),
		getAllTools: () => [{ name: "tool_search", reachesTools: () => "all" }, ...tools.values()],
		getActiveTools: () => active,
		setActiveTools: (names) => { active = names; },
	};
	claudeArtifacts(pi, { cacheDir, idleMs: 300, ...options, env: { PATH: claudeBin, ...options.env } });
	return { handlers, tools, active: () => active };
}

// Without Claude Code on the PATH the feature adds nothing, so its default costs nothing there.
const absent = load({ env: { PATH: os.tmpdir() } });
assert.equal(absent.tools.size + absent.handlers.size, 0, "no tools, skills or handlers without Claude Code");

// Loading starts no lasting process: Claude Code lists its tools once, Pi saves them per binary.
const loaded = load({ env: { SIGNED_OUT: "1" } });
await loaded.handlers.get("tool_call")({ toolName: "tool_search", toolCallId: "s0", input: {} }, { cwd: "/" });
assert.deepEqual([...loaded.tools.keys()], [TOOL], "a signed-out Claude Code lists only Artifact");
assert.deepEqual(starts().map(([, ...args]) => args.join(" ")), ["mcp serve"]);
assert.equal(fs.readdirSync(cacheDir).length, 0, "an incomplete list is not saved");
const calls = [];
const opened = [];
const { handlers, tools, active } = load({ env: {}, deleteArtifact: async (id) => { calls.push(id); }, openUrl: async (link) => { opened.push(link); } });
await handlers.get("tool_call")({ toolName: "tool_search", toolCallId: "s1", input: {} }, { cwd: "/" });
assert.deepEqual([...tools.keys()], [TOOL, `${TOOL}Comments`, `${TOOL}Data`], "only the three artifact tools, under their MCP names");
assert.equal(fs.readdirSync(cacheDir).length, 1);
const again = load({ env: {} });
await again.handlers.get("tool_call")({ toolName: "tool_search", toolCallId: "s2", input: {} }, { cwd: "/" });
assert.equal(again.tools.size, 3);
assert.equal(starts().length, 2, "a saved list starts no Claude Code");
const artifactTool = tools.get(TOOL);
assert.equal(artifactTool.exposure, "deferred", "loaded only when the model searches for them");
assert.equal(artifactTool.description, "Artifact from Claude Code");
assert.deepEqual(artifactTool.annotations, { destructiveHint: true });

// Calls run in the session's folder in one Claude Code, started by the first call, with artifacts on.
const callDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-cwd-")));
const executed = await artifactTool.execute("e1", { action: "list" }, undefined, undefined, { cwd: callDir });
assert.deepEqual(JSON.parse(executed.content[0].text), { tool: "Artifact", args: { action: "list" }, cwd: callDir, artifact: "1", nodeOptions: null });
assert.notEqual(executed.isError, true);
assert.equal((await artifactTool.execute("e2", { action: "fail" }, undefined, undefined, { cwd: callDir })).isError, true, "Claude Code's errors stay errors");
assert.equal(starts().length, 3, "an editing burst shares one Claude Code");
const [burstPid] = starts().at(-1);
await artifactTool.execute("e3", {}, undefined, undefined, { cwd: fs.realpathSync(os.tmpdir()) });
assert.equal(starts().length, 4, "another folder gets its own Claude Code");
assert(await until(() => !running(burstPid)), "the previous one is closed");
const [idlePid] = starts().at(-1);
assert(await until(() => !running(idlePid)), "an idle Claude Code exits");
await artifactTool.execute("e4", {}, undefined, undefined, { cwd: callDir });
assert.equal(starts().length, 5, "the next call starts it again");
process.kill(Number(starts().at(-1)[0]));
assert(await until(() => !running(starts().at(-1)[0])));
assert.equal(JSON.parse((await artifactTool.execute("e5", {}, undefined, undefined, { cwd: callDir })).content[0].text).tool, "Artifact", "a Claude Code that died is replaced, not waited on");
assert.equal(starts().length, 6);
const cancel = new AbortController();
const hung = artifactTool.execute("e6", { action: "hang" }, cancel.signal, undefined, { cwd: callDir });
cancel.abort();
await assert.rejects(hung);
await artifactTool.execute("e7", {}, undefined, undefined, { cwd: callDir });
assert.equal(starts().length, 7, "a cancelled call's Claude Code is replaced, so a stuck one holds up nothing");
const slow = artifactTool.execute("e8", { action: "slow" }, undefined, undefined, { cwd: callDir });
await artifactTool.execute("e9", {}, undefined, undefined, { cwd: callDir });
assert.equal(JSON.parse((await slow).content[0].text).args.action, "slow", "the idle timer waits for every running call");
const withOptions = async (NODE_OPTIONS) => {
	const session = load({ env: { NODE_OPTIONS } });
	await session.handlers.get("tool_call")({ toolName: "tool_search", toolCallId: "s3", input: {} }, { cwd: "/" });
	const options = JSON.parse((await session.tools.get(TOOL).execute("e5", {}, undefined, undefined, { cwd: callDir })).content[0].text).nodeOptions;
	const [pid] = starts().at(-1);
	assert(running(pid), "Claude Code stays up through the idle period");
	session.handlers.get("session_shutdown")();
	assert(await until(() => !running(pid)), "shutting the session down closes it");
	return options;
};
assert.equal(await withOptions("--max-old-space-size=4096"), "--max-old-space-size=4096", "unrelated NODE_OPTIONS are inherited untouched");
assert.equal(await withOptions("--use-openssl-ca --max-old-space-size=4096"), "--max-old-space-size=4096");
assert.equal(await withOptions("--use-openssl-ca"), "");

// Cancellation and the call timeout also cover a server that never finishes initialization.
const stalled = load({ env: { HANG_INITIALIZE: "1" } });
await stalled.handlers.get("tool_call")({ toolName: "tool_search", toolCallId: "stalled", input: {} }, { cwd: "/" });
const startupCancel = new AbortController();
let startupError;
const initializing = stalled.tools.get(TOOL).execute("startup-cancel", {}, startupCancel.signal, undefined, { cwd: callDir }).catch((error) => { startupError = error; });
startupCancel.abort();
try {
	assert(await until(() => startupError), "cancellation must not wait for initialization");
	assert.match(startupError.message, /Cancelled/);
	await initializing;
} finally {
	stalled.handlers.get("session_shutdown")();
}
const beforeTimeout = starts().length;
const timeoutStarted = new Promise((resolve) => {
	const watcher = fs.watch(path.join(claudeBin, "starts"), () => {
		if (starts().length > beforeTimeout) { watcher.close(); resolve(); }
	});
});
mock.timers.enable({ apis: ["setTimeout"] });
try {
	const timed = stalled.tools.get(TOOL).execute("startup-timeout", {}, undefined, undefined, { cwd: callDir });
	const rejected = assert.rejects(timed, /did not answer within 300 seconds/);
	await timeoutStarted;
	mock.timers.tick(300_000);
	await rejected;
} finally {
	mock.timers.reset();
	stalled.handlers.get("session_shutdown")();
}
assert(await until(() => !running(starts().at(-1)[0])), "a timed-out startup is closed");

// tool_search is turned on, and the system prompt names the tools in one stable line.
handlers.get("session_start")({});
assert(active().includes("tool_search"));
const options = { systemPromptOptions: { sections: {} } };
handlers.get("before_agent_start")(options);
assert(options.systemPromptOptions.sections.claude_artifacts);

const answers = [];
const ui = { select: async (title, options) => { answers.push({ title, options }); return answers.next; } };
const ctx = (hasUI = true) => ({ hasUI, ui, signal: undefined, cwd: "/work" });
const call = (input, id = "c1") => ({ toolName: TOOL, toolCallId: id, input });
const toolCall = handlers.get("tool_call");
const toolResult = handlers.get("tool_result");
const url = "https://claude.ai/artifact/LJaep3MewcVy4xEYAWvrCA";

assert.equal(await toolCall(call({ action: "read", url }), ctx()), undefined, "only deletes are gated");
assert.equal(await toolCall({ ...call({ action: "delete", url }), toolName: "mcp__other__Artifact" }, ctx()), undefined);
assert.equal(answers.length, 0);

assert.equal((await toolCall(call({ action: "delete", url }), ctx(false))).block, true, "a session that cannot ask deletes nothing");

answers.next = "Keep";
const declined = await toolCall(call({ action: "delete", url }), ctx());
assert.equal(declined.block, true);
assert.match(answers[0].title, /Permanently delete this Claude artifact\?[\s\S]*LJaep3MewcVy4xEYAWvrCA/);
assert.deepEqual(calls, [], "a declined delete never reaches the API");

answers.next = "Delete";
assert.equal(await toolCall(call({ action: "delete", url }, "c2"), ctx()), undefined, "a confirmed delete lets the native call run");
assert.deepEqual(calls, [uuid]);
const replaced = await toolResult({ toolCallId: "c2", toolName: TOOL, input: { action: "delete", url }, isError: true, content: [{ type: "text", text: "This delete was not confirmed by the user" }] }, ctx());
assert.equal(replaced.isError, false, "the native refusal is replaced by Pi's confirmed delete");
assert.equal(JSON.parse(replaced.content[0].text).deleted, true);

// Both native link forms resolve to the same API deletion target.
for (const link of ["https://claude.ai/artifact/Native-Pi-Test-LJaep3MewcVy4xEYAWvrCA?x=1", `https://claude.ai/code/artifact/${uuid.toUpperCase()}`]) {
	const event = call({ action: "delete", url: link }, link);
	await toolCall(event, ctx());
	assert.equal(calls.at(-1), uuid);
	assert.equal((await toolResult({ ...event, isError: true, content: [] }, ctx())).isError, false);
}

// Claude Code reports `opened` over MCP without opening anything, so Pi opens the link.
const nativeOpen = { toolCallId: "c4", toolName: TOOL, input: { action: "open", url }, isError: false, content: [{ type: "text", text: '{"opened":true}' }] };
const shown = await toolResult(nativeOpen, ctx());
assert.deepEqual(opened, [url]);
assert.equal(shown.content[0].text, '{"opened":true}');
await toolResult(nativeOpen, ctx(false));
assert.deepEqual(opened, [url], "a session without a screen opens nothing");
assert.equal(await toolResult({ ...nativeOpen, isError: true }, ctx()), undefined, "a failed open is left alone");

// The live check reads claude.ai's metadata, where a single-page artifact's index.html has no hash.
const liveCheck = spawnSync("python3", ["-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("api", sys.argv[1]); api = importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
api.access_token = lambda: "token"
api.request = lambda *_args, **_kwargs: {"ver": "7-a", "files": [{"path": "index.html", "contentType": "text/html"}, {"path": "theme.css", "sha256": "c55"}]}
sys.argv = ["artifact-api.py", "live", "${uuid}"]
api.main()
`, path.join(import.meta.dirname, "../lib/claude-artifacts/artifact-api.py")], { encoding: "utf8" });
assert.equal(liveCheck.status, 0, liveCheck.stderr);
assert.deepEqual(JSON.parse(liveCheck.stdout), { artifact_id: uuid, version: "7-a", files: { "theme.css": "c55" } });

// `claude mcp serve` forgets every call, so Pi keeps the conversation's published files and seen versions.
const live = new Map();
const versionChecks = [];
const state = load({ env: {}, liveArtifact: async (id) => { versionChecks.push(id); return { version: live.get(id), files: {} }; } }).handlers;
const publish = async (input, result, id) => {
	const event = { toolName: TOOL, toolCallId: id, input };
	await state.get("tool_call")(event, ctx());
	await state.get("tool_result")({ ...event, isError: result === undefined, content: [{ type: "text", text: result === undefined ? "refused" : JSON.stringify(result) }] }, ctx());
	return event.input;
};
const published = { url, path: "/work/page.html", artifact_id: uuid, version: "1-a" };
const created = await publish({ file_path: "page.html", icon: "chart" }, published, "p1");
assert.deepEqual(created, { file_path: "page.html", icon: "chart" }, "a first publish is unchanged");
assert.deepEqual(versionChecks, []);
live.set(uuid, "1-a");
const redeploy = await publish({ file_path: "page.html", edits: [] }, { ...published, version: "2-b" }, "p2");
assert.equal(redeploy.url, url, "the same file redeploys to the same artifact");
assert.equal(redeploy.force, true, "the version this conversation published is still live");
assert.deepEqual(versionChecks, [uuid]);
for (const nulls of [{ type_url: null }, { url: null }, { type_url: null, url: null, files: null, root: null }]) {
	live.set(uuid, "2-b");
	const nullable = await publish({ file_path: "page.html", ...nulls }, { ...published, version: "2-b" }, "nullable");
	assert.equal(nullable.url, url, "null optional values still redeploy the same file");
	assert.equal(nullable.force, true, "null optional values still track the viewed version");
	assert.equal(nullable.overwrite_unread, undefined, "null file options do not make a multi-file publish");
}
live.set(uuid, "3-c");
const outdated = await publish({ file_path: "/work/page.html" }, undefined, "p3");
assert.equal(outdated.url, url);
assert.equal(outdated.force, undefined, "a newer version on claude.ai is left to Claude Code to refuse");
await publish({ action: "read", url }, { read: { result: `[Artifact ${uuid} (version 3-c) — owned by you, private]\n<html>` } }, "r1");
assert.equal((await publish({ url, file_path: "other.html" }, { ...published, path: "/work/other.html", version: "4-d" }, "p4")).force, true, "a read counts as seeing that version");
assert.equal((await publish({ file_path: "new.html" }, { ...published, url: "u2", path: "/work/new.html", artifact_id: "1b332a90-1fed-459c-bfe7-b8cebba86f37", version: "1" }, "p5")).url, undefined, "a different file is a new artifact");
assert.equal((await publish({ type_url: "https://claude.ai/artifact/type", file_path: "page.html" }, undefined, "p6")).url, undefined, "a typed create is never redirected");
live.set(uuid, "4-d");
const unseen = load({ env: {}, liveArtifact: async () => ({ version: "4-d", files: {} }) }).handlers;
const unknownEvent = { toolName: TOOL, toolCallId: "u1", input: { url, file_path: "page.html" } };
await unseen.get("tool_call")(unknownEvent, ctx());
assert.equal(unknownEvent.input.force, undefined, "an artifact this conversation never saw is not forced");
state.get("session_start")({});
assert.equal((await publish({ file_path: "page.html" }, undefined, "p7")).url, undefined, "a new session starts with no record");

// The same file is found through a symlinked folder, since Claude Code reports the real path.
const realDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-artifacts-"));
const linkDir = `${realDir}-link`;
fs.symlinkSync(realDir, linkDir);
fs.writeFileSync(path.join(realDir, "page.html"), "<p>x</p>");
const linked = load({ env: {}, liveArtifact: async () => ({ version: "1", files: {} }) }).handlers;
const linkedCall = { toolName: TOOL, toolCallId: "l1", input: { file_path: "page.html" } };
await linked.get("tool_result")({ ...linkedCall, isError: false, content: [{ type: "text", text: JSON.stringify({ url, path: path.join(realDir, "page.html"), artifact_id: uuid, version: "1" }) }] }, ctx());
const relinked = { toolName: TOOL, toolCallId: "l2", input: { file_path: "page.html" } };
await linked.get("tool_call")(relinked, { ...ctx(), cwd: linkDir });
assert.equal(relinked.input.url, url);
fs.rmSync(linkDir);
fs.rmSync(realDir, { recursive: true });

// A refused update gets the live version read into it, as Claude Code's own sessions do.
let liveVersion = "v-small";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-work-"));
fs.writeFileSync(path.join(work, "h.html"), "<p>mine</p>");
const livePage = path.join(work, "live.json");
fs.writeFileSync(livePage, `{"read":{"result":"[Artifact ${uuid} (version v-small) — owned by you]\\n<p>outside change</p>"}}`);
const handed = load({ env: { READ_PAGE: livePage }, liveArtifact: async () => ({ version: liveVersion, files: {} }) }).handlers;
const reads = () => claudeCalls().filter((params) => params.arguments.action === "read").map((params) => params.arguments.url);
const at = { ...ctx(), cwd: work };
const handCall = async (input, text, id, isError) => {
	const event = { toolName: TOOL, toolCallId: id, input };
	const blocked = await handed.get("tool_call")(event, at);
	if (blocked) return { input: event.input, blocked };
	return { input: event.input, result: await handed.get("tool_result")({ ...event, isError, content: [{ type: "text", text }] }, at) };
};
const readFileLines = (file, offset, limit, truncation) => handed.get("tool_result")({ toolName: "read", toolCallId: `r${offset}`, input: { path: file, offset, limit }, isError: false, content: [], details: truncation && { truncation } }, at);
await handCall({ file_path: "h.html" }, JSON.stringify({ url, path: path.join(fs.realpathSync(work), "h.html"), artifact_id: uuid, version: "v-old" }), "h1", false);
const refusal = await handCall({ file_path: "h.html" }, "You haven't viewed the latest version. Re-read it", "h2", true);
assert.equal(refusal.input.force, undefined);
assert.equal(refusal.result.content[0].text, "You haven't viewed the latest version. Re-read it", "Claude Code's refusal is kept");
assert.deepEqual(reads(), [url], "Pi reads the live version with Claude Code's own read");
assert.match(refusal.result.content[1].text, /outside change/, "the live page reaches the model");
const resent = await handCall({ file_path: "h.html" }, "{}", "h3", true);
assert.equal(resent.blocked.block, true, "the unchanged content is refused once more, as in Claude Code");
assert.match(resent.blocked.reason, /v-small/);
assert.equal((await handCall({ file_path: "h.html" }, "{}", "h4", true)).input.force, true, "the second unchanged resend goes through");

// When Claude Code's refusal already carries the live page, Pi only records it as seen.
liveVersion = "v-inline";
fs.writeFileSync(path.join(work, "h.html"), "<p>mine, merged</p>");
const inline = await handCall({ file_path: "h.html" }, "Publish refused. [Artifact x — live version; raw HTML follows]", "h5", true);
assert.equal(inline.result, undefined);
assert.equal(reads().length, 1, "no extra read when Claude Code handed the page over");
fs.writeFileSync(path.join(work, "h.html"), "<p>mine, merged again</p>");
assert.equal((await handCall({ file_path: "h.html" }, "{}", "h6", false)).input.force, true);

// A large page Claude Code saved to a file counts as seen once every line of it is read.
liveVersion = "v-large";
const savedFile = path.join(fs.realpathSync(work), "artifact-saved.html");
fs.writeFileSync(savedFile, "x");
const big = await handCall({ file_path: "h.html", edits: [] }, `You hadn't viewed the live version. Its full source (97.6KB) is saved at ${savedFile}: Read every line of that file (1200 lines; the last has no trailing newline)`, "h7", true);
assert.equal(big.result, undefined, "Claude Code's own instructions stand");
await readFileLines(savedFile, null, 600);
fs.writeFileSync(path.join(work, "h.html"), "<p>partly merged</p>");
const early = await handCall({ file_path: "h.html" }, "refused", "h8", true);
assert.equal(early.input.force, undefined, "a saved page counts as seen only once every line is read");
assert.match(early.result.content[1].text, /^600 lines/, "an early publish keeps the reading done so far");
await readFileLines(savedFile, 601, undefined, { truncated: true, outputLines: 300 });
await readFileLines(savedFile, 901, null);
assert.equal((await handCall({ file_path: "h.html" }, "{}", "h9", false)).input.force, true, "reading every line counts the saved version as seen");
fs.rmSync(work, { recursive: true });
assert.equal((await handCall({ action: "read", url }, "{}", "h10", true)).result, undefined, "only a refused publish gets the live version");

// A multi-file update may replace only published files this conversation saw unchanged.
const liveFiles = { version: "9", files: { "a.js": "sha-a", "b.css": "sha-b2", "c.png": "sha-c", "index.html": "sha-i" } };
const multi = load({ env: {}, liveArtifact: async () => liveFiles }).handlers;
const multiCall = async (input, text, id, isError = false) => {
	const event = { toolName: TOOL, toolCallId: id, input };
	await multi.get("tool_call")(event, ctx());
	await multi.get("tool_result")({ ...event, isError, content: [{ type: "text", text }] }, ctx());
	return event.input;
};
await multiCall({ file_path: "m.html", files: { "a.js": "a.js" } }, JSON.stringify({ url, path: "/work/m.html", artifact_id: uuid, version: "8", files_written: [{ path: "a.js", sha256: "sha-a" }] }), "m1");
await multiCall({ action: "list", scope: "files", url }, JSON.stringify({ file_list: { url, ver: "8", files: [{ path: "b.css", sha256: "sha-b1" }] } }), "m2");
await multiCall({ action: "read", url, paths: ["index.html"] }, JSON.stringify({ files_read: { url, files: [{ path: "index.html", sha256: "sha-i" }] } }), "m3");
await multiCall({ action: "read", url, paths: ["index.html", "c.png"] }, JSON.stringify({ files_read: { url, files: [{ path: "index.html", error: "read failed" }, { path: "c.png", error: "read failed" }] } }), "m3-errors");
const multiUpdate = await multiCall({ file_path: "m.html", files: { "a.js": "a.js", "b.css": "b.css", "c.png": "c.png" }, overwrite_unread: ["c.png"] }, "refused", "m4", true);
assert.equal(multiUpdate.url, url);
assert.equal(multiUpdate.force, undefined, "version 9 is newer than the 8 this conversation saw");
assert.deepEqual(multiUpdate.overwrite_unread, ["c.png", "a.js", "index.html"], "only files seen unchanged are added; b.css changed and a failed read does not erase the index.html hash");
await multiCall({ action: "read", url, path: "b.css" }, JSON.stringify({ file_read: { url, path: "b.css", sha256: "sha-b2" } }), "m5");
assert(( await multiCall({ url, file_path: "m.html", files: { "b.css": "b.css" } }, "refused", "m6", true)).overwrite_unread.includes("b.css"), "a file read counts as seen");
for (const nulls of [{}, { files: null }, { root: null }, { files: null, root: null, type_url: null }]) {
	assert.equal((await multiCall({ url, file_path: "m.html", ...nulls }, "refused", "m7", true)).overwrite_unread, undefined, "absent or null file options are a single-file publish");
}

// After a delete, publishing the same file again creates a new artifact.
const removing = load({ env: {}, deleteArtifact: async () => {}, liveArtifact: async () => ({ version: "1", files: {} }) }).handlers;
await removing.get("tool_result")({ toolName: TOOL, toolCallId: "d1", input: { file_path: "gone.html" }, isError: false, content: [{ type: "text", text: JSON.stringify({ url, path: "/work/gone.html", artifact_id: uuid, version: "1" }) }] }, ctx());
answers.next = "Delete";
await removing.get("tool_call")(call({ action: "delete", url }, "d2"), ctx());
await removing.get("tool_result")({ ...call({ action: "delete", url }, "d2"), isError: true, content: [] }, ctx());
const republish = call({ file_path: "gone.html" }, "d3");
await removing.get("tool_call")(republish, ctx());
assert.equal(republish.input.url, undefined);

const failing = load({ env: {}, deleteArtifact: async () => { throw new Error("HTTP 500"); } });
const failed = await failing.handlers.get("tool_call")(call({ action: "delete", url }), ctx());
assert.equal(failed.block, true);
assert.match(failed.reason, /HTTP 500/, "the model is told why the delete failed");

console.log("ok: claude-artifacts registration, link parsing, delete confirmation, open, live check, session Claude Code and conversation state");
