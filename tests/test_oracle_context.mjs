import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const agentDir = mkdtempSync(join(tmpdir(), "vibes-oracle-context-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: subagents } = await import("../extensions/subagents.ts");
const parent = '/tmp/parent with "quotes"/session.jsonl';

/** The prompt sections a real Pi child session sends to the model. */
async function sections(agent) {
	const faux = fauxProvider();
	let sent;
	faux.setResponses([(context) => { sent = context.messages[0].sections; return fauxAssistantMessage("ok"); }]);
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: agentDir, agentDir, settingsManager, noExtensions: true, noContextFiles: true, extensionFactories: [subagents],
		systemPrompt: `<active_agent name="${agent}"/>\n\nAgent prompt`,
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(agentDir, { parentSession: parent });
	const { session } = await createAgentSession({ cwd: agentDir, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, sessionManager, settingsManager });
	await session.prompt("hi");
	return sent;
}

try {
	for (const agent of ["oracle", "advisor"]) {
		assert.ok((await sections(agent)).oracle_parent.includes(`Parent session JSONL: ${JSON.stringify(parent)}\n`), agent);
	}
	assert.equal((await sections("worker")).oracle_parent, undefined);
	console.log("Oracle parent session pointer: ok");
} finally { rmSync(agentDir, { recursive: true, force: true }); }
