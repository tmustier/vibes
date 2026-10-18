import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute } from "node:path";
import { launch as launchOrb, openActor, ThreadConnection, waitFor } from "./connection.ts";
import type { Checkpoint } from "./protocol.ts";

const entryType = "amp-orbs-tracking";
const threadId = Type.String({ pattern: "^T-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: structuredClone(data) });
type Tracked = Checkpoint & { threadId: string };

export default function ampOrbs(pi: ExtensionAPI, { launch = launchOrb, open = openActor } = {}) {
	const threads = new Map<string, ThreadConnection>();
	let context: ExtensionContext | undefined;
	const updateStatus = () => {
		const disconnected = [...threads.values()].filter((thread) => thread.state.status.connection === "disconnected").length;
		context?.ui.setStatus("amp-orbs", threads.size ? `Amp: ${threads.size} watched${disconnected ? `, ${disconnected} disconnected` : ""}` : undefined);
	};
	const save = () => pi.appendEntry<Tracked[]>(entryType, [...threads].map(([threadId, thread]) => ({ threadId, ...thread.state.checkpoint() })));
	const untrack = (id: string) => {
		const thread = threads.get(id);
		thread?.stop();
		threads.delete(id);
		save();
		updateStatus();
		return Boolean(thread);
	};
	const track = (id: string, checkpoint?: Checkpoint) => {
		const thread = new ThreadConnection(id, checkpoint, open);
		threads.set(id, thread);
		thread.subscribe(() => {
			// An archived thread is finished: stop watching it quietly. A later status read or message re-checks it.
			if (thread.state.status.archived) { if (threads.get(id) === thread) untrack(id); return; }
			updateStatus();
			if (!thread.state.notification()) return;
			save();
			const status = thread.state.status;
			const reason = status.error || status.connectionError ? "failed" : status.questions.length ? "needs input" : status.approvals.length ? "needs approval in Amp" : "stopped (verify its result)";
			const content = [
				`Amp orb ${reason}: ${status.url}`,
				status.error ?? status.connectionError,
				status.questions.length || status.approvals.length ? "Read get_thread_status for the pending questions or approvals. Do not bypass human approval." : undefined,
				status.response,
			].filter(Boolean).join("\n\n");
			pi.sendMessage({ customType: "amp-orb-update", content, display: true, details: structuredClone(status) }, { triggerTurn: true, deliverAs: "followUp" });
		});
		thread.start();
		return thread;
	};
	const get = (id: string) => {
		const existing = threads.get(id);
		if (existing) return existing;
		const thread = track(id);
		save();
		return thread;
	};
	const stopAll = () => {
		for (const thread of threads.values()) thread.stop();
		threads.clear();
		updateStatus();
	};
	const restore = (ctx: ExtensionContext) => {
		stopAll();
		context = ctx;
		const entry = ctx.sessionManager.getBranch().findLast((e) => e.type === "custom" && e.customType === entryType);
		for (const item of (entry?.type === "custom" ? entry.data : []) as Tracked[]) track(item.threadId, item);
	};
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async () => stopAll());

	pi.registerTool({
		name: "create_thread", label: "Create Amp orb", executionMode: "sequential",
		description: "Launch a background Amp orb with the exact literal prompt (no intermediary model). Specify absolute local cwd, optional Amp project/repository, and native mode (low/medium/high/ultra or external-agent:claude-code). Tracked questions, errors and settled work wake this Pi session. Native features are passed through, not validated; inspect applied features. Never infer success from idle alone.",
		parameters: Type.Object({ prompt: Type.String({ minLength: 1 }), cwd: Type.String(), mode: Type.String({ minLength: 1 }), title: Type.Optional(Type.String()), project: Type.Optional(Type.String()), features: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, args, signal) {
			if (!isAbsolute(args.cwd)) throw new Error("cwd must be an absolute local directory; project selects the orb repository");
			const thread = get(await launch(args, signal));
			return result({ ...thread.state.status, requestedMode: args.mode, requestedFeatures: args.features ?? [] });
		},
	});
	pi.registerTool({
		name: "get_thread_status", label: "Amp thread status",
		description: "Read live Amp actor state, latest response (last 12000 characters), pending questions, approval gates and errors. Reading an existing thread tracks it in this Pi session. Idle is not a success verdict. Disconnected/unknown is not idle.",
		parameters: Type.Object({ threadId }),
		async execute(_id, args, signal) {
			const thread = get(args.threadId);
			// A failed connection is reported in the status itself.
			await thread.ready(signal).catch((error) => { if (signal?.aborted) throw error; });
			return result(thread.state.status);
		},
	});
	pi.registerTool({
		name: "send_thread_message", label: "Message Amp thread", executionMode: "sequential",
		description: "Send a literal message directly to the Amp orb, steering its next turn or answering a normal pending question. Re-arms background notification. Does not approve tools or bypass requiresHuman questions: resolve those in Amp. An acknowledgement means accepted, not completed. If delivery is uncertain, read status before retrying.",
		parameters: Type.Object({ threadId, message: Type.String({ minLength: 1 }) }),
		async execute(_id, args, signal) {
			const ack = await get(args.threadId).send(args.message, signal);
			save();
			return result({ threadId: args.threadId, ...ack });
		},
	});
	pi.registerTool({
		name: "stop_tracking_thread", label: "Stop watching Amp thread", executionMode: "sequential",
		description: "Stop this Pi session's local observer after reviewing an Amp thread's result. Persists across reload. Does not cancel, archive or change remote work. A later status read or message resumes tracking.",
		parameters: Type.Object({ threadId }),
		async execute(_id, args) {
			return result({ threadId: args.threadId, wasTracked: untrack(args.threadId) });
		},
	});
	pi.registerTool({
		name: "wait_for_threads", label: "Wait for Amp threads",
		description: "Await live events until ALL specified threads settle (idle after work, question, approval, or error), or timeout. Timeout returns current states, not failure. No polling and no Amp model call. Cancelling stops only this local wait; remote work and session observers continue.",
		parameters: Type.Object({ threads: Type.Array(threadId, { minItems: 1, maxItems: 10 }), timeout_seconds: Type.Optional(Type.Number({ minimum: 0, maximum: 600, default: 300 })) }),
		async execute(_id, args, signal) {
			const watched = args.threads.map(get);
			const settled = await waitFor(watched, () => watched.every((t) => t.state.status.settled), signal, (args.timeout_seconds ?? 300) * 1000);
			return result({ timedOut: !settled, threads: watched.map((t) => t.state.status) });
		},
	});
}
