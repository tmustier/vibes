import { createHash } from "node:crypto";

// Amp's observer protocol is not a public stability guarantee. Keep its boundary here.
export type Frame = Record<string, any>;
export type ThreadStatus = {
	threadId: string; url: string;
	connection: "connecting" | "connected" | "disconnected"; connectionError?: string; archived: boolean;
	state: string; settled: boolean; agentMode?: string; features: string[];
	questions: Frame[]; approvals: Frame[]; error?: string; response: string; messageId?: string;
};
/** Amp refuses observers for archived threads. Archiving is a deliberate end, not a failure. */
export const archivedError = "Amp thread is archived";
// agent-default (not a user rule): 2026-10-18. Consecutive failed connection attempts before a
// brief server or network error wakes Pi; with reconnect backoff this is about 30 seconds.
export const persistentFailures = 6;
// Server-side and network failures that usually clear on their own, so they wake Pi only once persistent.
const transientError = /^Amp actor (connection failed|authorization failed \(HTTP (429|5\d\d)\))$/;
export type Checkpoint = { pendingAfter?: string; ignoredQuestions?: string[]; notificationKeys?: string[]; episode?: number; userMessageId?: string };

function notificationKey(identity: unknown): string {
	const canonical = JSON.stringify(identity, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
	return createHash("sha256").update(canonical).digest("hex");
}
function requiresHuman(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	return Object.entries(value).some(([key, v]) => (key === "requiresHuman" && v === true) || requiresHuman(v));
}

export class ThreadState {
	status: ThreadStatus;
	private blocks = new Map<number, string>();
	private humanTools = new Set<string>();
	private assistantId?: string;
	private acknowledged = false;
	private snapshot = false;
	private started = false;
	private notified: Set<string>;
	// One completion or failure report per episode. Amp's retries, reconnects and new message IDs
	// stay in the same episode; it advances only when Pi sends, or when the orb starts new work
	// after an outcome was reported.
	private episode: number;
	// Persist the input boundary, not assistant IDs, which also change during retries.
	private userMessageId?: string;
	private replayedUserMessageId?: string;
	private runtimeError?: string;
	// Set by a send: until a new message appears, the old idle state and these questions are stale.
	private pendingAfter?: string;
	private ignoredQuestions: string[];
	private failures = 0;
	// An assistant attempt that streamed an error. Amp may retry it and carry on, so it is a
	// failure only if the thread then goes idle without any later assistant progress.
	private failedAttempt = false;

	constructor(threadId: string, origin: string, checkpoint: Checkpoint = {}) {
		this.pendingAfter = checkpoint.pendingAfter;
		this.ignoredQuestions = checkpoint.ignoredQuestions ?? [];
		this.notified = new Set(checkpoint.notificationKeys);
		this.episode = checkpoint.episode ?? 0;
		this.userMessageId = checkpoint.userMessageId;
		this.status = { threadId, url: `${origin}/threads/${threadId}`, connection: "connecting", archived: false, state: "unknown", settled: false, features: [], questions: [], approvals: [], response: "" };
	}
	checkpoint(): Checkpoint {
		return { pendingAfter: this.pendingAfter, ignoredQuestions: this.ignoredQuestions, notificationKeys: [...this.notified], episode: this.episode, userMessageId: this.userMessageId };
	}
	resetConnection() {
		this.acknowledged = this.snapshot = false;
		this.replayedUserMessageId = undefined;
		this.failedAttempt = false; this.runtimeError = undefined;
		this.status = { ...this.status, connection: "connecting", archived: false, state: "unknown", questions: [], approvals: [], error: undefined };
		this.update();
	}
	/** Amp refused to observe the thread because it is archived: finished, with nothing to report. */
	archive() {
		this.status = { ...this.status, connection: "disconnected", connectionError: archivedError, archived: true, questions: [], approvals: [] };
		this.update();
	}
	/** failures counts consecutive failed connection attempts, including this one. */
	disconnect(error: string, failures = 1) {
		this.failures = failures;
		this.status = { ...this.status, connection: "disconnected", connectionError: error };
		this.update();
	}
	rearm() {
		this.pendingAfter = this.status.messageId ?? "";
		this.ignoredQuestions = this.status.questions.map((q) => q.requestId);
		this.started = false; this.failedAttempt = false; this.runtimeError = undefined;
		this.episode++;
		this.status = { ...this.status, error: undefined, state: "unknown" };
		this.update();
	}
	/** Undo rearm() after Amp definitely refused the message. */
	cancelRearm() {
		this.pendingAfter = undefined;
		this.ignoredQuestions = [];
	}
	apply(frame: Frame | Frame[]) {
		if (Array.isArray(frame)) {
			for (const event of frame) this.event(event.type, event);
			// The stored-state batch includes agent_state even when replay is empty.
			if (frame.some((event) => event.type === "agent_state")) this.snapshot = true;
		} else if (frame.id === 1 && frame.result) this.acknowledged = true;
		else this.event(frame.method ?? frame.type, frame.params ?? frame);
		if (this.acknowledged && this.snapshot) {
			this.status = { ...this.status, connection: "connected", connectionError: undefined };
		}
		this.update();
	}
	private event(type: string, p: Frame) {
		const s = this.status;
		if (type === "agent_state") {
			s.state = p.state ?? "unknown";
			s.agentMode = p.agentMode; s.messageId = p.messageId;
			if (this.pendingAfter !== undefined && p.messageId && p.messageId !== this.pendingAfter) { this.pendingAfter = undefined; this.started = true; }
			if (this.pendingAfter === undefined && !["idle", "error", "unknown"].includes(s.state)) {
				// Working again: an earlier runtime error no longer describes the orb.
				this.started = true; this.runtimeError = undefined;
				if (this.reported()) this.episode++;
			}
		}
		if (type === "message_added" && p.message.role === "user") {
			this.replayedUserMessageId = p.message.messageId;
			if (s.connection === "connected" && p.message.messageId !== this.userMessageId) {
				// A live appended input cannot settle on the previous reply while queued.
				this.pendingAfter ??= s.messageId ?? "";
				this.ignoredQuestions = s.questions.map((q) => q.requestId);
				this.started = false; this.failedAttempt = false; this.runtimeError = undefined;
				s.state = "unknown";
			}
		}
		if (type === "thread_features") s.features = p.features;
		if (type === "tool_approval_queue") s.approvals = p.approvals;
		if (type === "error" || type === "executor_error") {
			this.runtimeError = String(p.message ?? p.error?.message ?? p.error ?? p.code ?? "Amp runtime error");
		}
		const plugin = type === "plugin_message" ? p.message : undefined;
		if (plugin?.event === "plugin.ui.snapshot") s.questions = plugin.data.requests.filter((r: Frame) => r.status === "pending");
		if (plugin?.event === "plugin.ui.request_added" || plugin?.event === "plugin.ui.request_settled") {
			const r = plugin.data.request;
			s.questions = s.questions.filter((q) => q.requestId !== r.requestId);
			if (r.status === "pending") s.questions.push(r);
		}
		if ((type === "message_added" || type === "message_updated") && p.message.role === "assistant") {
			this.assistant(p.message.messageId, p.message.content, 0, true);
			this.failedAttempt = false;
		}
		if (type === "delta" && p.role === "assistant") {
			this.assistant(p.messageId, p.blocks, p.blockIndex ?? 0, p.contentMode === "snapshot");
			this.failedAttempt = p.state === "error";
		}
	}
	private assistant(messageId: string, blocks: Frame[] = [], offset: number, replace: boolean) {
		if (replace || messageId !== this.assistantId) { this.blocks.clear(); this.assistantId = messageId; }
		blocks.forEach((b, i) => {
			if (b.type === "tool_use" && b.id && requiresHuman(b.input)) this.humanTools.add(b.id);
			if (b.type === "text") this.blocks.set(offset + i, (this.blocks.get(offset + i) ?? "") + (b.text ?? ""));
		});
		if (this.pendingAfter === undefined) this.started = true;
		this.status.response = [...this.blocks.values()].join("\n").slice(-12000);
	}
	private effectiveQuestions() { return this.status.questions.filter((q) => !this.ignoredQuestions.includes(q.requestId)); }
	private update() {
		const s = this.status;
		// Compare only after the complete snapshot/ack gate: older inputs in full-history
		// replay are not new tasks. A different latest input recovers work completed offline.
		if (s.connection === "connected" && this.replayedUserMessageId !== undefined) {
			if (this.userMessageId !== undefined && this.userMessageId !== this.replayedUserMessageId && this.reported()) this.episode++;
			this.userMessageId = this.replayedUserMessageId;
		}
		// A failed attempt is a failure only once the orb stops; Amp's own "error" state is always one.
		const stopped = s.state === "error" || (this.failedAttempt && s.state === "idle");
		s.error = this.runtimeError ?? (stopped ? (this.failedAttempt ? "Amp assistant message failed" : "Amp orb stopped with an error") : undefined);
		for (const question of s.questions) {
			if (this.humanTools.has(question.invocation?.id)) question.requiresHuman = true;
		}
		s.settled = s.archived || s.connection === "connected" && Boolean(s.error || this.effectiveQuestions().length || s.approvals.length || (s.state === "idle" && this.started));
		// Older checkpoints identified outcomes by message and response, before episodes existed.
		// Hydrating that same reply must retain its acknowledgement, not wake Pi on upgrade.
		if (this.episode === 0 && s.settled && (s.error || s.state === "idle")) {
			const legacy = s.error ? ["error", s.messageId, s.error] : ["idle", s.messageId, this.assistantId, s.response];
			if (this.notified.has(notificationKey(legacy))) this.notified.add(notificationKey([s.error ? "failed" : "completed", this.episode]));
		}
	}
	private reported() {
		return ["completed", "failed"].some((outcome) => this.notified.has(notificationKey([outcome, this.episode])));
	}
	/** Identities of the current actionable state that Pi has not seen yet. Reading does not mark them seen. */
	unseen(): string[] {
		const s = this.status;
		// Archiving is a deliberate end. A thread archived mid-wait still releases waits via settled.
		if (s.archived) return [];
		if (s.connection === "disconnected") {
			if (/^Amp actor (disconnected|transport error|synchronization timed out)$/.test(s.connectionError ?? "")) return [];
			if (transientError.test(s.connectionError ?? "") && this.failures < persistentFailures) return [];
			const key = notificationKey(["connection-error", s.messageId, s.connectionError]);
			return this.notified.has(key) ? [] : [key];
		}
		if (!s.settled) return [];
		// Each pending request is independent: removing or reordering known requests must not
		// wake Pi, and a known question must never mask a failure.
		const identities: unknown[] = this.effectiveQuestions().map((q) => ["question", [q.requestId]]);
		identities.push(...s.approvals.map((approval) => ["approval", [approval]]));
		if (s.error) identities.push(["failed", this.episode]);
		if (!identities.length) identities.push(["completed", this.episode]);
		return identities.map(notificationKey).filter((key) => !this.notified.has(key));
	}
	/** Record the current state as seen by Pi, through a wake-up or a tool result. Returns whether anything was new. */
	markSeen(): boolean {
		const keys = this.unseen();
		for (const key of keys) this.notified.add(key);
		return keys.length > 0;
	}
	assertCanSend() {
		if (this.status.connection !== "connected") throw new Error("Amp state is not synchronized; cannot send safely");
		if (this.status.approvals.length || this.status.questions.some(requiresHuman)) throw new Error(`Human action required in ${this.status.url}; no message sent`);
	}
}
