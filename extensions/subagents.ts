import { bundled } from "../lib/bundled.ts";
import { feature } from "../lib/feature.ts";

const loadSubagents = bundled(import.meta.url, { package: "pi-subagents" });

export default feature(import.meta.url, async (pi) => {
	await loadSubagents(pi);
	// A fresh Oracle gets the parent's history as a file to read, not as an inherited session.
	pi.on("before_agent_start", (event, ctx) => {
		const parent = ctx.sessionManager.getHeader()?.parentSession;
		if (!parent || !/^<active_agent name="(?:oracle|advisor)"\/>/m.test(event.systemPrompt)) return;
		event.systemPromptOptions.sections.oracle_parent = `Parent session JSONL: ${JSON.stringify(parent)}\nRead this file when you need context from the parent conversation.`;
	});
});
