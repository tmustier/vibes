import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bundled } from "../lib/bundled.ts";
import { feature } from "../lib/feature.ts";

const loadSurf = bundled(import.meta.url, {
	package: "surf-cli",
	skills: ["skills"],
});

// After an update, Chrome keeps running Surf's old extension code until the extension is reloaded.
// The old code still works until Chrome restarts; then every command fails with
// extension_identity_missing. Restarting Chrome, which Surf's own error suggests, does not help.
const STALE_EXTENSION = /extension_identity_missing|Unknown tool: session\./;
const RELOAD = "Vibes: Chrome is running an older copy of Surf's extension than the installed Surf. Reload it yourself, then retry: with Computer Use, open chrome://extensions in a new tab of the user's Chrome, click Reload on the Surf card, and close that tab. Restarting Chrome does not fix this. Ask the user to click Reload only if you cannot reach Chrome.";

export default feature(import.meta.url, async (pi: ExtensionAPI) => {
	await loadSurf(pi);
	pi.on("tool_result", (event) => {
		const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		if (!STALE_EXTENSION.test(text)) return;
		return { content: [...event.content, { type: "text", text: RELOAD }], structuredContent: event.structuredContent };
	});
});
