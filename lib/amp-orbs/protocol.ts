import { createHash } from "node:crypto";

// Amp's observer protocol is not a public stability guarantee. Keep its boundary here.
export type Frame = Record<string, any>;
export type ThreadStatus = {
	threadId: string; url: string;
	connection: "connecting" | "connected" | "disconnected"; connectionError?: string;
	state: string; settled: boolean; agentMode?: string; features: string[];
	questions: Frame[]; approvals: Frame[]; error?: string; response: string; messageId?: string;
};
export type Checkpoint = { pendingAfter?: string; ignoredQuestions?: string[]; notificationKeys?: string[] };

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
	// An idle notification is due; cleared once sent so trailing deltas cannot repeat it.
	private armed = true;
	private notified: Set<string>;
	// Set by a send: until a new message appears, the old idle state and these questions are stale.
	private pendingAfter?: string;
	private ignoredQuestions: string[];

	constructor(threadId: string, origin: string, checkpoint: Checkpoint = {}) {
		this.pendingAfter = checkpoint.pendingAfter;
		this.ignoredQuestions = checkpoint.ignoredQuestions ?? [];
		this.notified = new Set(checkpoint.notificationKeys);
		this.status = { threadId, url: `${origin}/threads/${threadId}`, connection: "connecting", state: "unknown", settled: false, features: [], questions: [], approvals: [], response: "" };
	}
	checkpoint(): Checkpoint {
		return { pendingAfter: this.pendingAfter, ignoredQuestions: this.ignoredQuestions, notificationKeys: [...this.notified] };
	}
	resetConnection() {
		this.acknowledged = this.snapshot = false;
		this.status = { ...this.status, connection: "connecting", state: "unknown", questions: [], approvals: [], error: undefined };
		this.update();
	}
	disconnect(error: string) {
		this.status = { ...this.status, connection: "disconnected", connectionError: error };
		this.update();
	}
	rearm() {
		this.pendingAfter = this.status.messageId ?? "";
		this.ignoredQuestions = this.status.questions.map((q) => q.requestId);
		this.armed = true; this.started = false;
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
			if (this.pendingAfter === undefined && s.state !== "idle" && s.state !== "unknown") { this.started = true; this.armed = true; }
		}
		if (type === "thread_features") s.features = p.features;
		if (type === "tool_approval_queue") s.approvals = p.approvals;
		if (type === "error" || type === "executor_error") {
			s.error = String(p.message ?? p.error?.message ?? p.error ?? p.code ?? "Amp runtime error"); this.armed = true;
		}
		const plugin = type === "plugin_message" ? p.message : undefined;
		if (plugin?.event === "plugin.ui.snapshot") s.questions = plugin.data.requests.filter((r: Frame) => r.status === "pending");
		if (plugin?.event === "plugin.ui.request_added" || plugin?.event === "plugin.ui.request_settled") {
			const r = plugin.data.request;
			s.questions = s.questions.filter((q) => q.requestId !== r.requestId);
			if (r.status === "pending") { s.questions.push(r); this.armed = true; }
		}
		if ((type === "message_added" || type === "message_updated") && p.message.role === "assistant") this.assistant(p.message.messageId, p.message.content, 0, true);
		if (type === "delta" && p.role === "assistant") {
			this.assistant(p.messageId, p.blocks, p.blockIndex ?? 0, p.contentMode === "snapshot");
			if (p.state === "error") s.error = "Amp assistant message failed";
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
		for (const question of s.questions) {
			if (this.humanTools.has(question.invocation?.id)) question.requiresHuman = true;
		}
		s.settled = s.connection === "connected" && Boolean(s.error || this.effectiveQuestions().length || s.approvals.length || (s.state === "idle" && this.started));
	}
	/** Whether actionable work has not yet been reported. */
	notification(): boolean {
		const s = this.status;
		if (s.connection === "disconnected") {
			if (/^Amp actor (disconnected|transport error|synchronization timed out)$/.test(s.connectionError ?? "")) return false;
			const key = notificationKey(["connection-error", s.messageId, s.connectionError]);
			if (this.notified.has(key)) return false;
			this.notified.add(key);
			return true;
		}
		if (!s.settled) return false;
		// Each pending request/error is independent: removing or reordering known
		// requests must not wake Pi, and a known question must never mask an error.
		const identities: unknown[] = this.effectiveQuestions().map((q) => ["question", [q.requestId]]);
		identities.push(...s.approvals.map((approval) => ["approval", [approval]]));
		if (s.error) identities.push(["error", s.messageId, s.error]);
		if (!identities.length) {
			if (!this.armed) return false;
			identities.push(["idle", s.messageId, this.assistantId, s.response]);
			this.armed = false;
		}
		const unseen = identities.map(notificationKey).filter((key) => !this.notified.has(key));
		for (const key of unseen) this.notified.add(key);
		return unseen.length > 0;
	}
	assertCanSend() {
		if (this.status.connection !== "connected") throw new Error("Amp state is not synchronized; cannot send safely");
		if (this.status.approvals.length || this.status.questions.some(requiresHuman)) throw new Error(`Human action required in ${this.status.url}; no message sent`);
	}
}
