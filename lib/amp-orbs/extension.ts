import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute } from "node:path";
import { launch as launchOrb, openActor, ThreadConnection, waitFor } from "./connection.ts";
import type { Checkpoint, ThreadStatus } from "./protocol.ts";

const entryType = "amp-orbs-tracking";
const holdEntryType = "amp-orbs-wake-hold";
const threadId = Type.String({ pattern: "^T-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: structuredClone(data) });
type Tracked = Checkpoint & { threadId: string };
type WakeHold = { failures: number; until: number };

// agent-default (not a user rule): 2026-10-22. How long an orb's new state must hold before it wakes
// Pi, so Amp's retries, reconnects and brief error states settle first.
const defaultQuietMs = 20_000;
// agent-default (not a user rule): 2026-10-22. After Pi's own model call fails (for example a 429),
// wake-ups wait this long before trying again, growing with each further failure. A successful reply
// from the user's next message ends the wait at once.
const defaultHoldMs = [5 * 60_000, 15 * 60_000, 60 * 60_000];

const describe = (status: ThreadStatus) => {
	const reason = status.error || status.connectionError ? "failed" : status.questions.length ? "needs input" : status.approvals.length ? "needs approval in Amp" : "stopped (verify its result)";
	return [
		`Amp orb ${reason}: ${status.url}`,
		status.error ?? status.connectionError,
		status.questions.length || status.approvals.length ? "Read get_thread_status for the pending questions or approvals. Do not bypass human approval." : undefined,
		status.response,
	].filter(Boolean).join("\n\n");
};

/**
 * Orb updates wait here, never in Pi's follow-up queue, where they could not be merged, dropped when
 * a thread is no longer watched, or matched against what Pi already read. While Pi works, nothing is
 * sent. Once Pi is idle, every orb whose new state has held for the quiet period goes out in one
 * message, which starts one turn.
 */
export default function ampOrbs(pi: ExtensionAPI, { launch = launchOrb, open = openActor, quietMs = defaultQuietMs, holdMs = defaultHoldMs } = {}) {
	const threads = new Map<string, ThreadConnection>();
	// When each thread's unseen state was first observed. An entry outlives brief absences (a reconnect
	// replay, a short burst of work), so the same state returning keeps its original time.
	const since = new Map<string, { identity: string; at: number }>();
	const current = () => [...since].filter(([id, s]) => threads.get(id)?.state.unseen().join() === s.identity);
	let hold: WakeHold | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let context: ExtensionContext | undefined;
	const held = () => Boolean(hold && Date.now() < hold.until);
	const updateStatus = () => {
		const disconnected = [...threads.values()].filter((thread) => thread.state.status.connection === "disconnected").length;
		const waiting = held() ? current().length : 0;
		context?.ui.setStatus("amp-orbs", threads.size ? `Amp: ${threads.size} watched${disconnected ? `, ${disconnected} disconnected` : ""}${waiting ? `, ${waiting} held after a model error` : ""}` : undefined);
	};
	const save = () => pi.appendEntry<Tracked[]>(entryType, [...threads].map(([threadId, thread]) => ({ threadId, ...thread.state.checkpoint() })));
	const schedule = () => {
		clearTimeout(timer);
		timer = undefined;
		const pending = current();
		if (!pending.length) return;
		const due = Math.max(Math.min(...pending.map(([, s]) => s.at + quietMs)), held() ? hold!.until : 0);
		timer = setTimeout(flush, Math.max(0, due - Date.now()));
	};
	/** Note a thread's unseen state; a different state starts a new quiet period. */
	const observe = (id: string, thread: ThreadConnection) => {
		const identity = thread.state.unseen().join();
		if (identity && since.get(id)?.identity !== identity) since.set(id, { identity, at: Date.now() });
		schedule();
	};
	/** Pi read these threads in a tool result, so it needs no wake-up for what it saw. */
	const seen = (watched: ThreadConnection[]) => {
		if (watched.map((thread) => thread.state.markSeen()).some(Boolean)) save();
		for (const thread of watched) since.delete(thread.state.status.threadId);
		schedule();
	};
	const flush = () => {
		// While Pi works, wait for agent_settled (or compaction) to flush rather than polling.
		if (!context?.isIdle()) return;
		if (held()) return schedule();
		const now = Date.now();
		const ready = current().filter(([, s]) => now - s.at >= quietMs).map(([id]) => threads.get(id)!);
		if (!ready.length) return schedule();
		for (const thread of ready) { thread.state.markSeen(); since.delete(thread.state.status.threadId); }
		save();
		const statuses = ready.map((thread) => structuredClone(thread.state.status));
		const content = statuses.length === 1 ? describe(statuses[0]) : [`${statuses.length} Amp orb updates:`, ...statuses.map(describe)].join("\n\n---\n\n");
		pi.sendMessage({ customType: "amp-orb-update", content, display: true, details: { threads: statuses } }, { triggerTurn: true, deliverAs: "followUp" });
		updateStatus();
		schedule();
	};
	const untrack = (id: string) => {
		const thread = threads.get(id);
		thread?.stop();
		threads.delete(id);
		since.delete(id);
		save();
		updateStatus();
		schedule();
		return Boolean(thread);
	};
	const track = (id: string, checkpoint?: Checkpoint) => {
		const thread = new ThreadConnection(id, checkpoint, open);
		threads.set(id, thread);
		let observedCheckpoint = thread.state.checkpoint();
		thread.subscribe(() => {
			if (threads.get(id) !== thread) return;
			// An archived thread is finished: stop watching it quietly. A later status read or message re-checks it.
			if (thread.state.status.archived) { untrack(id); return; }
			// Persist observed new work before its outcome: a reload must not restore the previous
			// episode's completed identity and silently discard this episode's eventual result.
			const next = thread.state.checkpoint();
			if (next.episode !== observedCheckpoint.episode || next.userMessageId !== observedCheckpoint.userMessageId) { observedCheckpoint = next; save(); }
			observe(id, thread);
			updateStatus();
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
		since.clear();
		clearTimeout(timer);
		updateStatus();
	};
	const restore = (ctx: ExtensionContext) => {
		stopAll();
		context = ctx;
		const branch = ctx.sessionManager.getBranch();
		const savedHold = branch.findLast((e) => e.type === "custom" && e.customType === holdEntryType);
		// Deadlines and failure counts belong to the active branch, not the extension instance.
		hold = savedHold?.type === "custom" ? (savedHold.data as WakeHold | null) ?? undefined : undefined;
		const entry = branch.findLast((e) => e.type === "custom" && e.customType === entryType);
		for (const item of (entry?.type === "custom" ? entry.data : []) as Tracked[]) track(item.threadId, item);
	};
	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", async () => stopAll());
	// Pi has finished its run and nothing else is queued. If its last model call failed after its own
	// retries, every wake-up would fail the same way, so hold them instead of starting doomed turns.
	pi.on("agent_settled", async (_event, ctx) => {
		const last = ctx.sessionManager.getBranch().findLast((e) => e.type === "message" && e.message.role === "assistant");
		const failed = last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "error";
		const failures = failed ? (hold?.failures ?? 0) + 1 : 0;
		hold = failures ? { failures, until: Date.now() + holdMs[Math.min(failures, holdMs.length) - 1] } : undefined;
		pi.appendEntry<WakeHold | null>(holdEntryType, hold ?? null);
		updateStatus();
		flush();
	});
	pi.on("session_compact", async () => flush());
	pi.on("session_compact_failed", async () => flush());

	pi.registerTool({
		name: "create_thread", label: "Create Amp orb", executionMode: "sequential",
		description: "Launch a background Amp orb with the exact literal prompt (no intermediary model), sent as a message from this Pi session rather than the user. Specify absolute local cwd, optional Amp project/repository, and native mode (low/medium/high/ultra or external-agent:claude-code). Tracked questions, errors and settled work wake this Pi session. Native features are passed through, not validated; inspect applied features. Never infer success from idle alone.",
		parameters: Type.Object({ prompt: Type.String({ minLength: 1 }), cwd: Type.String(), mode: Type.String({ minLength: 1 }), title: Type.Optional(Type.String()), project: Type.Optional(Type.String()), features: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, { prompt, ...args }, signal, _onUpdate, ctx) {
			if (!isAbsolute(args.cwd)) throw new Error("cwd must be an absolute local directory; project selects the orb repository");
			const sessionId = ctx.sessionManager.getSessionId();
			const id = await launch({ ...args, sessionId }, signal);
			const thread = get(id);
			await thread.send(prompt, { sessionId, opening: true }, signal).catch((error) => {
				throw new Error(`Amp orb ${id} was created but its task was not delivered (${error.message}). Read get_thread_status before sending the task with send_thread_message.`);
			});
			save();
			seen([thread]);
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
			if (threads.get(args.threadId) === thread) seen([thread]);
			return result(thread.state.status);
		},
	});
	pi.registerTool({
		name: "send_thread_message", label: "Message Amp thread", executionMode: "sequential",
		description: "Send a literal message directly to the Amp orb as a message from this Pi session, steering its next turn or answering a normal pending question. Re-arms background notification. Does not approve tools or bypass requiresHuman questions: resolve those in Amp. An acknowledgement means accepted, not completed. If delivery is uncertain, read status before retrying.",
		parameters: Type.Object({ threadId, message: Type.String({ minLength: 1 }) }),
		async execute(_id, args, signal, _onUpdate, ctx) {
			const ack = await get(args.threadId).send(args.message, { sessionId: ctx.sessionManager.getSessionId(), opening: false }, signal);
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
			seen(watched.filter((t) => threads.get(t.state.status.threadId) === t));
			return result({ timedOut: !settled, threads: watched.map((t) => t.state.status) });
		},
	});
}
