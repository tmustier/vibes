import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { feature } from "../lib/feature.ts";
/**
 * /wut explains recent activity without interrupting the agent. /wut auto on|off toggles its watchdog,
 * which prods a looping agent and interrupts a tool call the agent is pointlessly blocked on.
 */

import { uuidv7, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, getAgentDir, getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const DEFAULT_QUESTION = "What's going on? Give me a quick update.";
const SYSTEM_PROMPT =
	"You are watching a coding agent work on behalf of its user. Explain what happened and what it is doing right now in plain language. Don't use the agent's jargon and speak coherently. State it simply and concisely, like one human talking to another.";

const MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_GOAL_CHARS = 3_000;
const MAX_ASSISTANT_CHARS = 4_000;
const MAX_TOOL_ARG_CHARS = 600;
const MAX_TOOL_RESULT_CHARS = 1_500;
const MAX_PARTIAL_CHARS = 2_000;
const MAX_COMPACTION_CHARS = 2_000;
const MAX_SHOWN_EXCHANGES = 3;
const OVERLAY_HEIGHT_FRACTION = 0.85;
const SCROLL_STEP = 5;

// Watchdog (auto-wut). Each action has its own rules; checks run when either could fire.
// Prod a looping agent: after minRunMs on the user's message and WATCHDOG_MIN_EVENTS tool calls since
//   the last check; at most WATCHDOG_MAX_PRODS per message, prodCooldownMs after the last prod,
//   interrupt or warning.
// Interrupt a hung call: once it has blocked the agent for longToolMs; once per message, never delayed
//   by a prod.
export const WATCHDOG_TIMING = {
	minRunMs: 15 * 60_000,
	tickMs: 30_000,
	checkIntervalMs: 3 * 60_000, // min gap between observer checks
	longToolMs: 10 * 60_000,
	prodCooldownMs: 10 * 60_000,
};
export type WatchdogTiming = typeof WATCHDOG_TIMING;
const WATCHDOG_MIN_EVENTS = 3; // min tool events since last check
const WATCHDOG_MAX_PRODS = 2; // per real user message
const WATCHDOG_PROD_PREFIX = "<wut_watchdog>";
const WATCHDOG_INTERRUPT_MARK = `${WATCHDOG_PROD_PREFIX} wut interrupted`;
const WATCHDOG_QUESTION = [
	"This is an automatic check, not the user asking.",
	"Judge whether the agent is genuinely stuck: repeating near-identical commands or edits, hitting the same error again and again, undoing and redoing the same change, or looping without getting closer to the goal.",
	"Also judge any tool call listed as running right now. The agent can do nothing else until it returns. It is hung if it is waiting on something that will not happen, sleeping or polling far longer than the task needs, or has stalled with no sign of finishing.",
	"Slow, methodical progress is NOT stuck. A long-running build, test, or download that is still making progress is NOT hung. Never call a tool hung if stopping it could leave work half-done: a push, deploy, migration, message send, or anything else that changes state. Be conservative: only call it stuck or hung with clear evidence.",
	"If a running tool call is clearly hung, reply exactly: HUNG: <one short sentence - why waiting on it is pointless and one concrete suggestion>",
	"Otherwise, if the agent is clearly stuck, reply exactly: STUCK: <one short sentence - what it keeps repeating and one concrete suggestion>",
	"Otherwise reply exactly: OK",
].join("\n");

const clip = (text: string, max: number): string => {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	const head = Math.ceil(max * 0.6);
	const tail = Math.floor(max * 0.4);
	const omitted = trimmed.length - head - tail;
	return `${trimmed.slice(0, head)}\n[… ${omitted} chars omitted …]\n${trimmed.slice(trimmed.length - tail)}`;
};

const blockText = (content: Message["content"], type: "text" | "thinking" = "text"): string => {
	if (typeof content === "string") return type === "text" ? content : "";
	return content
		.flatMap((block) => {
			if (block.type === "text" && type === "text") return [block.text];
			if (block.type === "thinking" && type === "thinking") return [block.thinking];
			return [];
		})
		.filter((text) => text.trim())
		.join("\n");
};

interface LiveState {
	partialText: string;
	partialThinking: string;
	running: Map<string, RunningTool>;
}

interface RunningTool {
	desc: string;
	startedAt: number;
	output?: { at: number; text: string };
}

const SYNTHETIC_USER_PREFIXES = ["<pi_goal_continuation ", WATCHDOG_PROD_PREFIX];

const buildTranscript = (ctx: ExtensionContext, live: LiveState, lastRealInputAt?: number): string => {
	const entries = ctx.sessionManager.getBranch();
	const inputs = entries.flatMap((entry, index) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const text = blockText(entry.message.content).trimStart();
		if (SYNTHETIC_USER_PREFIXES.some((prefix) => text.startsWith(prefix))) return [];
		return [{ index, text, timestamp: entry.message.timestamp }];
	});
	// Match observed input, or use the newest real user message after reload/resume.
	const input =
		inputs.find((entry) => lastRealInputAt !== undefined && entry.timestamp >= lastRealInputAt) ??
		inputs.at(-1);
	const sections = [
		input
			? `The user's last message (the goal):\n${clip(input.text, MAX_GOAL_CHARS)}`
			: "The user has not sent any message yet in this session.",
	];

	for (let i = (input?.index ?? -1) + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "compaction") {
			sections.push(
				`(the agent's context was compacted here - its own summary of everything before this point:\n${clip(entry.summary, MAX_COMPACTION_CHARS)})`,
			);
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;

		if (msg.role === "assistant") {
			const text = blockText(msg.content, "text");
			if (text) sections.push(`Agent said:\n${clip(text, MAX_ASSISTANT_CHARS)}`);
			for (const block of msg.content) {
				if (block.type === "toolCall")
					sections.push(`Agent ran tool ${block.name}: ${clip(JSON.stringify(block.arguments), MAX_TOOL_ARG_CHARS)}`);
			}
		} else if (msg.role === "toolResult") {
			const text = blockText(msg.content, "text");
			const status = msg.isError ? " (FAILED)" : "";
			sections.push(`Result of ${msg.toolName}${status}:\n${clip(text || "(no output)", MAX_TOOL_RESULT_CHARS)}`);
		} else if (msg.role === "user") {
			// Only synthetic nudges can appear here (real ones are the anchor).
			const text = blockText(msg.content, "text").trimStart();
			sections.push(
				text.startsWith(WATCHDOG_INTERRUPT_MARK)
					? "(watchdog interrupt: the agent's blocking tool call was stopped because it looked hung, and the agent was told to reassess)"
					: text.startsWith(WATCHDOG_PROD_PREFIX)
						? "(watchdog prod: the agent was warned it might be going in circles and told to reassess)"
						: "(automatic nudge: the agent was told to keep working toward its active long-running goal)",
			);
		}
	}

	// Keep the goal, drop the oldest activity if the transcript is too big.
	let total = sections.reduce((n, s) => n + s.length + 2, 0);
	let dropped = 0;
	while (sections.length > 2 && total > MAX_TRANSCRIPT_CHARS) {
		total -= sections[1].length + 2;
		sections.splice(1, 1);
		dropped++;
	}
	if (dropped > 0) sections.splice(1, 0, `[… ${dropped} earlier steps omitted …]`);

	// Live, in-flight state (not yet in the session).
	const liveLines: string[] = [];
	if (live.running.size > 0) {
		const now = Date.now();
		const minutes = (ms: number) => `${Math.round(ms / 6_000) / 10} min`;
		const tools = [...live.running.values()].map((tool) => {
			const quiet = tool.output ? `last output ${minutes(now - tool.output.at)} ago` : "no output yet";
			const output = tool.output?.text ? `\nLatest output:\n${tool.output.text}` : "";
			return `${tool.desc}\n(running for ${minutes(now - tool.startedAt)}, ${quiet})${output}`;
		});
		liveLines.push(`Tools running right now (the agent is blocked until they return):\n${tools.join("\n\n")}`);
	}
	const partial = (live.partialText || live.partialThinking).trim();
	if (partial) {
		const tail = partial.length > MAX_PARTIAL_CHARS ? `[…] ${partial.slice(-MAX_PARTIAL_CHARS)}` : partial;
		liveLines.push(`Agent's ${live.partialText ? "reply so far" : "in-progress thinking"} (still streaming):\n${tail}`);
	}
	if (liveLines.length > 0) {
		sections.push(`RIGHT NOW (in flight):\n${liveLines.join("\n\n")}`);
	} else if (ctx.isIdle()) {
		sections.push("The agent is currently idle - it has finished and is waiting for the user.");
	} else {
		sections.push("The agent is currently working (between steps).");
	}

	return sections.join("\n\n");
};

const firstPrompt = (transcript: string, question: string): string =>
	`Here is what the coding agent has been doing since the user's last message:\n\n<activity>\n${transcript}\n</activity>\n\n${question}`;

const makeUserMessage = (text: string): Message => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

const observerModels = (ctx: ExtensionContext) => {
	const path = join(getAgentDir(), "wut.json");
	let text: string | undefined;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const configured = text !== undefined;
	let references = ["openai-codex/gpt-6-luna", "openai/gpt-6-luna"];
	if (text !== undefined) {
		let config: unknown;
		try {
			config = JSON.parse(text);
		} catch (error) {
			throw new Error(`${path}: ${error instanceof Error ? error.message : error}`);
		}
		assert(config && typeof config === "object" && "models" in config && Object.keys(config).length === 1,
			`${path}: expected an object containing only a models list`);
		assert(Array.isArray(config.models) && config.models.length > 0, `${path}: models must be a nonempty list`);
		references = config.models.map((reference: unknown) => {
			assert(typeof reference === "string" && /^[^/\s]+\/\S+$/.test(reference), `${path}: expected provider/model-id`);
			return reference;
		});
	}
	const observers = [...new Set(references)].flatMap((reference) => {
		const slash = reference.indexOf("/");
		const model = ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1));
		return model && ctx.modelRegistry.hasConfiguredAuth(model) ? [model] : [];
	});
	if (!configured && observers.length === 0 && ctx.model) observers.push(ctx.model);
	return observers;
};

const askObserver = async (
	ctx: ExtensionContext,
	messages: Message[],
	sessionId: string,
	signal?: AbortSignal,
): Promise<AssistantMessage> => {
	const models = observerModels(ctx);
	let model = models.shift();
	assert(model, "No authenticated wut model available; check /login and wut.json");
	for (;;) {
		signal?.throwIfAborted();
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages },
				{ reasoningEffort: "low", sessionId, signal },
			);
			if (response.stopReason === "aborted") {
				throw new DOMException(response.errorMessage || "aborted", "AbortError");
			}
			if (response.stopReason === "error") throw new Error(response.errorMessage || "error");
			return response;
		} catch (error) {
			const fallback = models.shift();
			if (!fallback || signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
			model = fallback;
		}
	}
};

/** Build the extension; tests pass shorter watchdog timings. */
export const createWut = (timing: WatchdogTiming = WATCHDOG_TIMING) => (pi: ExtensionAPI) => {
	const live: LiveState = { partialText: "", partialThinking: "", running: new Map() };
	// The watchdog's budget for the user's latest message; unset until the user speaks.
	let task: { startedAt: number; prods: number; interrupted: boolean; lastActionAt: number } | undefined;

	let watchdogEnabled = true;
	let watchdogTimer: ReturnType<typeof setInterval> | undefined;
	let watchdogRequest: AbortController | undefined;
	let lastCheckAt = 0;
	let toolEventsSinceCheck = 0;
	// Keep prods out of Pi's queue: abort would move a queued steer into the user's editor.
	let pending: { kind: "prod" | "interrupt"; text: string } | undefined;

	const blockingTools = (now: number) =>
		[...live.running.values()].filter((tool) => now - tool.startedAt > timing.longToolMs);

	const stopWatching = () => {
		clearInterval(watchdogTimer);
		watchdogTimer = undefined;
		watchdogRequest?.abort();
		pending = undefined;
		live.partialText = "";
		live.partialThinking = "";
		live.running.clear();
	};
	pi.on("session_shutdown", stopWatching);
	pi.on("agent_settled", () => {
		const note = pending;
		stopWatching();
		// Pi defers a prompt sent while settling until the session is idle.
		if (note?.kind === "interrupt") pi.sendUserMessage(note.text);
	});
	pi.on("session_start", () => {
		stopWatching();
		task = undefined;
	});

	// /wut skips the input event, so opening it never moves the anchor.
	pi.on("input", (event) => {
		if (event.source === "extension") return;
		watchdogRequest?.abort();
		pending = undefined;
		task = { startedAt: Date.now(), prods: 0, interrupted: false, lastActionAt: 0 };
	});

	pi.on("agent_start", (_event, ctx) => {
		stopWatching();
		lastCheckAt = Date.now();
		toolEventsSinceCheck = 0;
		watchdogTimer = setInterval(async () => {
			if (!watchdogEnabled || watchdogRequest || ctx.isIdle()) return;
			const now = Date.now();
			// A new user message aborts this request, so the task cannot change under it.
			const current = task;
			if (!current || now - lastCheckAt < timing.checkIntervalMs) return;
			const mayProd = now - current.startedAt >= timing.minRunMs && toolEventsSinceCheck >= WATCHDOG_MIN_EVENTS;
			if (!mayProd && blockingTools(now).length === 0) return;
			const request = new AbortController();
			watchdogRequest = request;
			try {
				const response = await askObserver(
					ctx,
					[makeUserMessage(firstPrompt(buildTranscript(ctx, live, current.startedAt), WATCHDOG_QUESTION))],
					uuidv7(),
					request.signal,
				);
				const verdict = /^(STUCK|HUNG)\b[:\s]*([\s\S]*)/i.exec(blockText(response.content).trim());
				if (request.signal.aborted || ctx.isIdle() || !verdict) return;
				const actionAt = Date.now();
				const coolingDown = actionAt - current.lastActionAt < timing.prodCooldownMs;
				const hung = verdict[1].toUpperCase() === "HUNG";
				const reason = verdict[2].trim() || (hung ? "the call looks hung" : "repeating the same actions without progress");
				// The call may have returned while the observer answered.
				const blocking = blockingTools(actionAt);
				const interrupt = hung && blocking.length > 0;
				if (!interrupt && !mayProd) return;
				if (coolingDown && (!interrupt || current.interrupted)) return;
				current.lastActionAt = actionAt;

				let notice: string;
				if (interrupt && current.interrupted) {
					notice = `agent looks blocked again (${reason}) - not interrupting again, take a look`;
				} else if (interrupt) {
					current.interrupted = true;
					const minutes = Math.round((actionAt - Math.min(...blocking.map((tool) => tool.startedAt))) / 60_000);
					pending = {
						kind: "interrupt",
						text: `${WATCHDOG_INTERRUPT_MARK} you: you had been blocked for ${minutes} min on:\n${blocking.map((tool) => tool.desc).join("\n")}\nObserver: ${reason}\nThe call was stopped. Check the state it left behind, then choose a new approach: retry with a timeout, run it in the background, or change course toward the user's goal.`,
					};
					ctx.abort();
					notice = `interrupted the agent's blocked tool call - ${reason}`;
				} else if (current.prods === WATCHDOG_MAX_PRODS) {
					notice = `agent still looks stuck (${reason}) - not prodding again, take a look`;
				} else {
					current.prods++;
					const prod = `${WATCHDOG_PROD_PREFIX} A friendly observer agent thinks you may be going in circles. It said: ${reason}\nPause, consider the user's intent, and consider whether you should take a step back and change approach, fix the source of current friction directly to enable progress, or stay the course. Then proceed with your chosen course of action.`;
					if (blocking.length > 0) {
						pending = { kind: "prod", text: prod };
						notice = `will prod the agent when its current tool call returns - ${reason}`;
					} else {
						pi.sendUserMessage(prod, { deliverAs: "steer" });
						notice = `prodded the agent - ${reason}`;
					}
				}
				if (ctx.hasUI) ctx.ui.notify(`wut: ${notice}`, "warning");
			} catch {
				// A failed background observation must not interrupt the agent.
			} finally {
				watchdogRequest = undefined;
				lastCheckAt = Date.now();
				toolEventsSinceCheck = 0;
			}
		}, timing.tickMs);
		watchdogTimer.unref();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		live.partialText = blockText(event.message.content, "text");
		live.partialThinking = blockText(event.message.content, "thinking");
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		live.partialText = "";
		live.partialThinking = "";
	});

	pi.on("tool_execution_start", (event) => {
		live.running.set(event.toolCallId, {
			desc: `${event.toolName}: ${clip(JSON.stringify(event.args), MAX_TOOL_ARG_CHARS)}`,
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_update", (event) => {
		const tool = live.running.get(event.toolCallId);
		if (!tool) return;
		tool.output = { at: Date.now(), text: blockText(event.partialResult.content).trim().slice(-MAX_TOOL_RESULT_CHARS) };
	});

	pi.on("tool_execution_end", (event) => {
		live.running.delete(event.toolCallId);
		toolEventsSinceCheck++;
		if (pending?.kind === "prod" && live.running.size === 0) {
			pi.sendUserMessage(pending.text, { deliverAs: "steer" });
			pending = undefined;
		}
	});

	pi.registerCommand("wut", {
		description:
			"Plain-language update on what the agent is doing; '/wut auto on|off' toggles the watchdog that prods a stuck agent and interrupts a hung tool call",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (/^auto\b/i.test(trimmed)) {
				const arg = trimmed.slice(4).trim().toLowerCase();
				if (arg === "on") watchdogEnabled = true;
				else if (arg === "off") {
					watchdogEnabled = false;
					watchdogRequest?.abort();
					pending = undefined;
				}
				const status = watchdogEnabled
					? `wut watchdog ON - checks every ${timing.checkIntervalMs / 60_000} min while the agent works, prods it (max ${WATCHDOG_MAX_PRODS} per task) when it looks stuck, and interrupts a tool call that has blocked it for ${timing.longToolMs / 60_000}+ min and looks hung (max one per task)`
					: "wut watchdog OFF";
				if (ctx.hasUI) ctx.ui.notify(status, "info");
				else console.log(status);
				return;
			}

			const initialQuestion = trimmed || DEFAULT_QUESTION;
			const observerSessionId = uuidv7();
			if (ctx.mode !== "tui") {
				const response = await askObserver(
					ctx,
					[makeUserMessage(firstPrompt(buildTranscript(ctx, live, task?.startedAt), initialQuestion))],
					observerSessionId,
				);
				const answer = blockText(response.content) || "(no answer)";
				if (ctx.hasUI) ctx.ui.notify(answer, "info");
				else console.log(answer);
				return;
			}

			const observer = observerModels(ctx)[0];
			const mdTheme = getMarkdownTheme();
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const exchanges: { question: string; answer: string }[] = [];
					let convo: Message[] = [];
					let status:
						| { kind: "asking"; question: string; controller: AbortController }
						| { kind: "failed"; error: string }
						| { kind: "ready" } = { kind: "ready" };
					let copied = false;
					let copyTimer: ReturnType<typeof setTimeout> | undefined;
					let scrollUp = 0; // lines scrolled up from the bottom (0 = pinned to bottom)

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: getSelectListTheme(),
					};
					const editor = new Editor(tui, editorTheme);

					const ask = async (question: string, reset: boolean) => {
						const controller = new AbortController();
						status = { kind: "asking", question, controller };
						scrollUp = 0;
						if (reset) convo = [];
						const messages = [
							...convo,
							makeUserMessage(
								convo.length ? question : firstPrompt(buildTranscript(ctx, live, task?.startedAt), question),
							),
						];
						tui.requestRender();
						try {
							const response = await askObserver(ctx, messages, observerSessionId, controller.signal);
							convo = [...messages, response];
							exchanges.push({ question, answer: blockText(response.content) || "(no answer)" });
							status = { kind: "ready" };
						} catch (err) {
							status = { kind: "failed", error: err instanceof Error ? err.message : String(err) };
						}
						// Closing the overlay is the only abort; nothing is left to render.
						if (controller.signal.aborted) return;
						scrollUp = 0;
						tui.requestRender();
					};

					editor.onSubmit = (value) => {
						if (status.kind === "asking") return;
						const question = value.trim();
						editor.setText("");
						void ask(question || DEFAULT_QUESTION, !question);
					};

					void ask(initialQuestion, true);
					return {
						render: (width: number): string[] => {
							const w = width;
							const inner = w - 4; // "│ " … " │"

							const content: string[] = [];
							const shown = exchanges.slice(-(MAX_SHOWN_EXCHANGES - (status.kind === "asking" ? 1 : 0)));
							if (exchanges.length > shown.length) {
								content.push(theme.fg("dim", `(${exchanges.length - shown.length} earlier answers hidden)`));
							}
							for (const exchange of shown) {
								content.push("", ...wrapTextWithAnsi(theme.fg("muted", `❯ ${exchange.question}`), inner));
								content.push(...new Markdown(exchange.answer, 1, 0, mdTheme).render(inner));
							}
							if (status.kind === "asking") {
								content.push("", ...wrapTextWithAnsi(theme.fg("muted", `❯ ${status.question}`), inner));
								content.push("", theme.fg("dim", "thinking…"));
							}
							if (status.kind === "failed") {
								content.push("", ...wrapTextWithAnsi(theme.fg("error", `Error: ${status.error}`), inner));
							}

							content.push("");
							content.push(...editor.render(inner));
							content.push(
								copied
									? theme.fg("success", "copied ✓")
									: theme.fg("dim", "Enter ask · empty Enter refresh · ^O copy · Esc close"),
							);

							// Viewport: pi clips overlays at maxHeight from the top, which would
							// hide the editor and latest answer. Window the content ourselves,
							// pinned to the bottom, scrollable with PgUp/PgDn.
							const termRows = tui.terminal.rows;
							const maxContent = Math.max(6, Math.floor(termRows * OVERLAY_HEIGHT_FRACTION) - 2);
							let visible = content;
							const overflow = Math.max(0, content.length - maxContent);
							if (scrollUp > overflow) scrollUp = overflow;
							if (overflow > 0) {
								const start = overflow - scrollUp;
								visible = content.slice(start, start + maxContent);
								if (start > 0) visible[0] = theme.fg("dim", `↑ ${start} more (PgUp)`);
								if (scrollUp > 0) visible[visible.length - 1] = theme.fg("dim", `↓ ${scrollUp} more (PgDn)`);
							}

							// Rounded frame with the title in the top border.
							const lines: string[] = [];
							const title = truncateToWidth(` wut · ${observer?.id ?? "no model"} `, w - 3);
							const fill = Math.max(0, w - 3 - visibleWidth(title));
							lines.push(
								theme.fg("accent", "╭─") +
									theme.fg("accent", theme.bold(title)) +
									theme.fg("accent", `${"─".repeat(fill)}╮`),
							);
							const bar = theme.fg("accent", "│");
							for (const raw of visible) {
								const line = visibleWidth(raw) > inner ? truncateToWidth(raw, inner) : raw;
								const pad = " ".repeat(Math.max(0, inner - visibleWidth(line)));
								lines.push(`${bar} ${line}${pad} ${bar}`);
							}
							lines.push(theme.fg("accent", `╰${"─".repeat(w - 2)}╯`));

							return lines;
						},
						invalidate: () => editor.invalidate(),
						dispose: () => {
							clearTimeout(copyTimer);
							if (status.kind === "asking") status.controller.abort();
						},
						handleInput: (data: string) => {
							if (matchesKey(data, Key.escape)) {
								done(undefined);
								return;
							}
							if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.alt("up"))) {
								scrollUp += SCROLL_STEP;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.alt("down"))) {
								scrollUp = Math.max(0, scrollUp - SCROLL_STEP);
								tui.requestRender();
								return;
							}
							if (matchesKey(data, Key.ctrl("o"))) {
								const latest = exchanges.at(-1);
								if (latest?.answer) {
									void copyToClipboard(latest.answer);
									copied = true;
									clearTimeout(copyTimer);
									copyTimer = setTimeout(() => {
										copied = false;
										tui.requestRender();
									}, 1500);
									tui.requestRender();
								}
								return;
							}
							editor.handleInput(data);
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						width: "75%",
						minWidth: 60,
						maxHeight: `${Math.round(OVERLAY_HEIGHT_FRACTION * 100)}%`,
						anchor: "center",
					},
				},
			);
		},
	});
};

export default feature(import.meta.url, createWut());
