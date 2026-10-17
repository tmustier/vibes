import { feature } from "../lib/feature.ts";
/** Ask for approval on each Superhuman send, including native codemode and legacy adapter calls. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEND_TOOL = "mcp__superhuman-mail__send_draft";
const ADAPTER_APPROVAL = "pi-mcp-adapter:tool-approval-request";

type Ui = { select(title: string, options: string[]): Promise<string | undefined> };
type AdapterRequest = {
	serverName: string;
	originalToolName: string;
	args: Record<string, unknown>;
	claim(handler: () => Promise<"allow_once" | "deny">): boolean;
};

async function approve(ui: Ui | undefined, args: Record<string, unknown>, server = "superhuman-mail"): Promise<boolean> {
	if (!ui) return false;
	const details = Object.entries(args)
		.map(([key, value]) => `  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join("\n");
	return await ui.select(`Send this email now? (${server} send_draft)\n\n${details}`, ["Send", "Don't send"]) === "Send";
}

export default feature(import.meta.url, (pi: ExtensionAPI) => {
	let legacyUi: Ui | undefined;
	pi.on("session_start", (_event, ctx) => {
		legacyUi = ctx.hasUI ? ctx.ui : undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== SEND_TOOL) return;
		if (!(await approve(ctx.hasUI ? ctx.ui : undefined, event.input as Record<string, unknown>))) {
			return { block: true, reason: "Email send not approved." };
		}
	});

	// Keep the existing approval broker while users migrate their personal adapter installs.
	pi.events.on(ADAPTER_APPROVAL, (data) => {
		const request = data as AdapterRequest;
		if (request.originalToolName !== "send_draft") return;
		request.claim(async () => (await approve(legacyUi, request.args, request.serverName)) ? "allow_once" : "deny");
	});
});
