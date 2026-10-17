// Every native or legacy adapter MCP email send asks individually; headless calls are denied.
import assert from "node:assert/strict";
import sendApproval from "../extensions/send-approval.ts";

const start = (hasUI, answers = []) => {
	const handlers = {};
	const asked = [];
	const ui = { select: async (title) => (asked.push(title), answers.shift()) };
	sendApproval({
		on: (event, handler) => (handlers[event] = handler),
		events: { on: (channel, handler) => (handlers[channel] = handler) },
	});
	handlers.session_start({}, { hasUI, ui });
	const native = (tool, input = { draft_id: "d1" }) => handlers.tool_call(
		{ toolName: tool, input, parentToolCallId: "codemode-call" }, { hasUI, ui },
	);
	const adapter = async (tool, args = { draft_id: "d1" }) => {
		let claimed;
		handlers["pi-mcp-adapter:tool-approval-request"]({
			serverName: "superhuman-mail", originalToolName: tool, args,
			claim: (handler) => ((claimed = handler), true),
		});
		return claimed ? claimed() : "not claimed";
	};
	return { native, adapter, asked };
};

const session = start(true, ["Send", "Send", "Don't send", undefined, "Send", "Don't send"]);
assert.equal(await session.native("mcp__superhuman-mail__send_draft", { draft_id: "d1", send_at: "2026-10-01T09:00" }), undefined);
assert.match(session.asked[0], /Send this email now\?[\s\S]*draft_id: d1[\s\S]*send_at: 2026-10-01T09:00/);
assert.equal(await session.native("mcp__superhuman-mail__send_draft"), undefined, "a second send needs approval too");
assert.equal((await session.native("mcp__superhuman-mail__send_draft")).block, true);
assert.equal((await session.native("mcp__superhuman-mail__send_draft")).block, true, "dialog dismissed");
assert.equal(await session.adapter("send_draft"), "allow_once");
assert.equal(await session.adapter("send_draft"), "deny");
assert.equal(session.asked.length, 6);
assert.equal(await session.native("mcp__superhuman-mail__create_or_update_draft"), undefined);
assert.equal(await session.adapter("create_or_update_draft"), "not claimed");
assert.equal((await start(false).native("mcp__superhuman-mail__send_draft")).block, true);
assert.equal(await start(false).adapter("send_draft"), "deny");
console.log("ok");
