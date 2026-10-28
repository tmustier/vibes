// Explicit live test: npx jiti tests/claude_artifacts_acceptance.mjs /absolute/evidence/directory
// Uses the authenticated local Pi model and Claude Code accounts. Never run as part of unit tests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAgentSession, createCodemodeExtension, createMcpExtension, createToolSearchExtension, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import claudeArtifacts, { callClaudeCode } from "../lib/claude-artifacts/extension.ts";

const evidence = process.argv[2];
assert(evidence && path.isAbsolute(evidence), "Supply an absolute scratch evidence directory");
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const cwd = fs.mkdtempSync(path.join(evidence, "workspace-"));
const root = path.resolve(import.meta.dirname, "..");
const events = [];
const record = (event) => { events.push({ at: new Date().toISOString(), ...event }); fs.writeFileSync(path.join(evidence, "events.json"), JSON.stringify(events, null, 2), { mode: 0o600 }); };
const marker = `pi-acceptance-${randomUUID().slice(0, 8)}`;
const check = (id) => JSON.parse(execFileSync("python3", [path.join(root, "tests/claude_artifacts_check.py"), "state", id], { encoding: "utf8" }));

/** Claude Code's own tool from a separate server: an independent reader and an outside writer. */
const nativeCall = async (name, args, dir = cwd) => (await callClaudeCode(name, args, dir)).content.map((block) => block.text ?? "").join("\n");

const runtime = await ModelRuntime.create();
const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
assert(model, "Approved model must exist in registry");
record({ type: "model", provider: model.provider, model: model.id, thinking: "medium", revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), claudeCode: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim() });

// The user's answers to Pi's delete question: decline first, then confirm.
const answers = ["Keep", "Delete"];
const opened = [];
const theme = new Proxy({}, { get: () => (...args) => args.at(-1) });
const uiContext = {
	select: async (title, options) => { const answer = answers.shift(); record({ type: "ui_select", title, options, answer }); return answer; },
	confirm: async () => false, input: async () => undefined, notify: () => {}, onTerminalInput: () => () => {},
	setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
	setWidget: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {}, custom: async () => undefined,
	pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "", editor: async () => undefined,
	addAutocompleteProvider: () => {}, setEditorComponent: () => {}, getEditorComponent: () => undefined,
	theme, getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false, error: "test UI" }),
	getToolsExpanded: () => false, setToolsExpanded: () => {},
};
const ambientSettings = SettingsManager.create(cwd, getAgentDir()).getSettings();
const settingsManager = SettingsManager.inMemory({
	...ambientSettings,
	extensions: [...(ambientSettings.extensions ?? []), "!**/claude-artifacts.ts"],
	packages: (ambientSettings.packages ?? []).map((entry) => {
		const config = typeof entry === "string" ? { source: entry } : entry;
		return { ...config, extensions: [...(config.extensions ?? ["**/*"]), "-extensions/claude-artifacts.ts"] };
	}),
});
// The CLI's built-in extensions, which SDK sessions add themselves; the artifact tools load through tool_search.
const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager, extensionFactories: [
	createCodemodeExtension(),
	createToolSearchExtension(),
	createMcpExtension(),
	(pi) => claudeArtifacts(pi, { openUrl: async (url) => { opened.push(url); } }),
] });
await loader.reload();
assert.equal(loader.getExtensions().errors.length, 0, JSON.stringify(loader.getExtensions().errors));
const { session } = await createAgentSession({ cwd, resourceLoader: loader, settingsManager, modelRuntime: runtime, model, thinkingLevel: "medium", sessionManager: SessionManager.create(cwd, path.join(evidence, "sessions")) });
await session.bindExtensions({ uiContext, mode: "rpc", onError: (error) => record({ type: "extension_error", error: error.message }) });

const results = [];
const started = new Map();
session.subscribe((event) => {
	if (event.type === "tool_execution_start") { started.set(event.toolCallId, event.args); record({ type: event.type, name: event.toolName, args: event.args }); }
	if (event.type === "tool_execution_end") {
		try { const id = JSON.parse(event.result.content[0].text).artifact_id; if (id) created.add(id); } catch {}
		results.push({ name: event.toolName, args: started.get(event.toolCallId) ?? {}, result: event.result, isError: event.isError });
		record({ type: event.type, name: event.toolName, isError: event.isError, text: event.result?.content?.map((block) => block.text).join("\n").slice(0, 4000) });
	}
	if (event.type === "message_end" && event.message.role === "assistant") record({ type: "assistant", provider: event.message.provider, model: event.message.model, content: event.message.content.filter((block) => block.type === "text") });
});
const assistantSaid = (text) => events.some((e) => e.type === "assistant" && e.content.some((block) => block.text.includes(text)));
const ARTIFACT = "mcp__claude_artifacts__Artifact";
const deletes = () => results.filter((r) => r.name === ARTIFACT && r.args.action === "delete");

const outsideMarker = `outside-change-${randomUUID().slice(0, 8)}`;
const first = `This is a live acceptance test of the Claude artifact tools in Pi. Work only in ${cwd} and use only synthetic content. Do not open the artifact in a browser.
1. Following the Artifact tool's own instructions (including the artifact-design and artifact-capabilities skills it names), write and publish a small private page titled "Pi Artifact Acceptance" that shows the text "Revision one" and the marker ${marker}, and declares the db capability so the page can show a shared check record. Publish it with a supporting stylesheet theme.css, linked from the page and passed with the files option, containing the comment /* theme one */.
2. Change "Revision one" to "Revision two" and the stylesheet comment to /* theme two */, and republish both to the same URL.
3. Read the artifact back with the Artifact tool and confirm it says "Revision two".
4. With ArtifactData, set the document "acceptance" in collection "checks" to {"status": "ok", "marker": "${marker}"}, then get it back.
5. Read the artifact's comments with ArtifactComments.
6. Delete the artifact with the Artifact tool. Respect the user's answer and do not retry a delete the user declined.
End with STEP ONE DONE and the artifact URL.`;
const second = `This turn tests a stale publish. Change "Revision two" to "Revision three" in your existing local page file, then attempt to publish it to the same artifact with the stylesheet BEFORE calling Artifact read or list. If the publish refuses, use its response to merge any outside changes and retry. Do not pass force or overwrite_unread yourself. End with STEP TWO DONE.`;
const large = `This turn tests a stale publish of a large page. Using the Artifact tool's own edits parameter, attempt to change "Revision three" to "Revision four" in the same artifact BEFORE calling Artifact read or list. If the publish refuses, follow its instructions to read and merge the live page, then retry. Do not pass force or overwrite_unread yourself. End with STEP THREE DONE.`;
const third = "I've changed my mind: delete that artifact now. End with STEP FOUR DONE.";
fs.writeFileSync(path.join(evidence, "prompts.txt"), [first, second, large, third].join("\n\n---\n\n"));

let artifact;
let failure;
const created = new Set();
try {
	await session.prompt(first);
	await session.waitForIdle();
	assert(assistantSaid("STEP ONE DONE"), "the model did not finish step one");
	const publishes = results.filter((r) => r.name === ARTIFACT && !r.isError && (r.args.action ?? "publish") === "publish").map((r) => { try { return JSON.parse(r.result.content[0].text); } catch { return undefined; } }).filter((r) => r?.artifact_id);
	assert(publishes.length >= 2, "expected a publish and an update");
	artifact = publishes[0];
	assert(publishes.every((p) => p.artifact_id === artifact.artifact_id), "the update must keep the same artifact");
	assert(publishes.slice(1).every((p) => p.updated === true), "later publishes update in place");
	assert(publishes.some((p) => p.files_written?.some((file) => file.path === "theme.css")), "the stylesheet was published with the page");
	assert.equal(created.size, 1, "no extra artifact was created");
	record({ type: "artifact", url: artifact.url, id: artifact.artifact_id });

	const live = check(artifact.artifact_id);
	assert.equal(live.exists, true);
	assert.equal(live.role, "owner");
	assert.equal(live.audience, "owner", "a new artifact stays private");
	assert(live.html.includes("Revision two") && !live.html.includes("Revision one"), "claude.ai serves the updated page");
	assert(live.html.includes(marker));
	assert(Object.keys(live.capabilities ?? {}).includes("db"), "the db capability is declared on claude.ai");
	const stylesheet = await nativeCall("Artifact", { action: "read", url: artifact.url, path: "theme.css" });
	assert(stylesheet.includes("theme two") && !stylesheet.includes("theme one"), `claude.ai serves the updated stylesheet: ${stylesheet.slice(0, 300)}`);
	const database = await nativeCall("ArtifactData", { action: "get", url: artifact.url, collection: "checks", doc_id: "acceptance" });
	assert(database.includes(marker) && database.includes("ok"), `the shared record is readable from another Claude Code process: ${database.slice(0, 300)}`);
	record({ type: "independent_check", title: live.title, version: live.version, capabilities: live.capabilities, database: database.slice(0, 500) });

	for (const name of ["mcp__claude_artifacts__ArtifactData", "mcp__claude_artifacts__ArtifactComments"]) assert(results.some((r) => r.name === name && !r.isError), `${name} was not used successfully`);
	assert(events.some((e) => e.type === "tool_execution_start" && e.name === ARTIFACT && e.args.action === "read"), "the model did not read the artifact back");
	assert(events.some((e) => e.type === "tool_execution_start" && e.name === "read" && /artifact-(design|capabilities)/.test(String(e.args.path))), "the model did not load the guidance skills");
	assert.equal(deletes().length, 1, "one delete attempt, not retried after the user declined");
	assert.equal(deletes()[0].isError, true, "the declined delete was refused");
	assert.equal(events.filter((e) => e.type === "ui_select").length, 1, "Pi asked once and the model did not retry the declined delete");

	// Another writer changes the page, as a save from the page or another session would.
	const pageFile = publishes.at(-1).path;
	const outsideDir = fs.mkdtempSync(path.join(evidence, "outside-"));
	fs.writeFileSync(path.join(outsideDir, "page.html"), fs.readFileSync(pageFile, "utf8").replace(/<\/body>/i, `<p>${outsideMarker}</p></body>`));
	const outside = JSON.parse(await nativeCall("Artifact", { url: artifact.url, file_path: path.join(fs.realpathSync(outsideDir), "page.html"), force: true }, fs.realpathSync(outsideDir)));
	assert.equal(outside.updated, true, "the outside change was published");
	record({ type: "outside_change", version: outside.version });

	const before = results.length;
	await session.prompt(second);
	await session.waitForIdle();
	assert(assistantSaid("STEP TWO DONE"), "the model did not finish step two");
	const turn = results.slice(before).filter((r) => r.name === ARTIFACT);
	const refused = turn.findIndex((r) => r.isError && r.result.content.some((block) => /Pi has read the live version|live version; raw HTML follows/.test(block.text ?? "")));
	assert(refused >= 0, "the stale publish was refused with the live version read into it");
	assert(turn.slice(refused).at(-1).isError === false, "the model published again after merging");
	assert(!turn.slice(refused + 1).some((r) => r.args.action === "read" && r.args.path === undefined && r.args.paths === undefined), "the model merged from the handed-over page without reading the page again");
	const merged = check(artifact.artifact_id);
	assert(merged.html.includes(outsideMarker), "the other writer's change was kept");
	assert(merged.html.includes("Revision three"), "the model's change was published");
	assert(created.size === 1, "no extra artifact was created");
	assert((await nativeCall("Artifact", { action: "read", url: artifact.url, path: "theme.css" })).includes("theme two"), "the stylesheet is still served");
	record({ type: "independent_merge_check", version: merged.version });

	// Another writer adds over 50,000 characters, so the hand-over is a saved file to read in full.
	const lastLine = `${outsideMarker}-line-1199`;
	const bigLines = Array.from({ length: 1200 }, (_, i) => `<p>${outsideMarker}-line-${i}: synthetic filler for the large-page test</p>`).join("\n");
	fs.writeFileSync(path.join(outsideDir, "page.html"), fs.readFileSync(pageFile, "utf8").replace(/<\/body>/i, `${bigLines}\n</body>`));
	assert.equal(JSON.parse(await nativeCall("Artifact", { url: artifact.url, file_path: path.join(fs.realpathSync(outsideDir), "page.html"), force: true }, fs.realpathSync(outsideDir))).updated, true);
	const beforeLarge = results.length;
	await session.prompt(large);
	await session.waitForIdle();
	assert(assistantSaid("STEP THREE DONE"), "the model did not finish step three");
	const largeTurn = results.slice(beforeLarge);
	const savedNote = largeTurn.flatMap((r) => r.result.content.map((block) => block.text ?? "")).find((text) => /is saved at \S+?: Read every line/.test(text));
	assert(savedNote && /No edits were applied/.test(savedNote), "Claude Code saved the large live page to a file with its edits instructions");
	const savedFile = savedNote.match(/is saved at (\S+?): Read every line/)[1];
	assert(largeTurn.some((r) => r.name === "read" && path.resolve(cwd, String(r.args.path)).endsWith(path.basename(savedFile))), "the model read the saved page");
	assert.equal(largeTurn.filter((r) => r.name === ARTIFACT).at(-1).isError, false, "the model published after reading and merging");
	const afterLarge = check(artifact.artifact_id);
	assert(afterLarge.html.includes(lastLine) && afterLarge.html.includes("Revision four") && afterLarge.html.includes(outsideMarker), "both the large outside change and the model's change were published");
	record({ type: "independent_large_merge_check", version: afterLarge.version, chars: afterLarge.html.length });

	await session.prompt(third);
	await session.waitForIdle();
	assert(assistantSaid("STEP FOUR DONE"), "the model did not finish step four");
	const asked = events.filter((e) => e.type === "ui_select");
	assert.deepEqual(asked.map((e) => e.answer), ["Keep", "Delete"]);
	assert(asked.every((e) => e.title.includes("Permanently delete this Claude artifact?")));
	assert.equal(deletes().at(-1).isError, false, "the confirmed delete succeeded");
	assert.equal(JSON.parse(deletes().at(-1).result.content[0].text).deleted, true);
	assert.equal(check(artifact.artifact_id).exists, false, "claude.ai no longer serves the artifact");
	record({ type: "independent_delete_check", exists: false });
	assert.deepEqual(opened, [], "nothing was opened");
	assert(events.filter((e) => e.type === "assistant").every((e) => e.provider === "openai-codex" && e.model === "gpt-6.1-sol"), "actual model differs from approved model");
} catch (error) { failure = error; record({ type: "failure", message: error.message }); }
finally {
	await session.abort(); session.dispose();
	for (const id of created) {
		if (!check(id).exists) continue;
		execFileSync("python3", [path.join(root, "lib/claude-artifacts/artifact-api.py"), "delete", id]);
		record({ type: "cleanup_deleted", id });
	}
}
if (failure) { console.error(failure.message); process.exit(1); }
console.log(JSON.stringify({ passed: true, evidence, artifact: artifact.url }));
process.exit(0);
