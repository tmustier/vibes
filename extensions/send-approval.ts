import { feature } from "../lib/feature.ts";
/** Ask for approval on each Superhuman or Front send, including native codemode and legacy adapter calls. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Server name (as onboarding configures it) → its tool that sends email. */
const SEND_TOOLS: Record<string, string> = { "superhuman-mail": "send_draft", front: "send_message" };
const ADAPTER_APPROVAL = "pi-mcp-adapter:tool-approval-request";

type Ui = { select(title: string, options: string[]): Promise<string | undefined> };
type AdapterRequest = {
	serverName: string;
	originalToolName: string;
	args: Record<string, unknown>;
	claim(handler: () => Promise<"allow_once" | "deny">): boolean;
};

async function approve(ui: Ui | undefined, args: Record<string, unknown>, server: string, tool: string): Promise<boolean> {
	if (!ui) return false;
	const details = Object.entries(args)
		.map(([key, value]) => `  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join("\n");
	return await ui.select(`Send this email now? (${server} ${tool})\n\n${details}`, ["Send", "Don't send"]) === "Send";
}

export default feature(import.meta.url, (pi: ExtensionAPI) => {
	const native = new Map(Object.entries(SEND_TOOLS).map(([server, tool]) => [`mcp__${server}__${tool}`, [server, tool] as const]));
	let legacyUi: Ui | undefined;
	pi.on("session_start", (_event, ctx) => {
		legacyUi = ctx.hasUI ? ctx.ui : undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		const send = native.get(event.toolName);
		if (!send) return;
		if (!(await approve(ctx.hasUI ? ctx.ui : undefined, event.input as Record<string, unknown>, ...send))) {
			return { block: true, reason: "Email send not approved." };
		}
	});

	// Keep the existing approval broker while users migrate their personal adapter installs.
	pi.events.on(ADAPTER_APPROVAL, (data) => {
		const request = data as AdapterRequest;
		if (!Object.values(SEND_TOOLS).includes(request.originalToolName)) return;
		request.claim(async () => (await approve(legacyUi, request.args, request.serverName, request.originalToolName)) ? "allow_once" : "deny");
	});
});
