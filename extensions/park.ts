import { feature } from "../lib/feature.ts";
/**
 * Park idle Pi sessions: the process exits (freeing its memory) while the rendered
 * transcript stays on screen, and a keypress brings it back. Opt-in: parking requires
 * launching Pi through scripts/pi-park (see the README), which keeps the terminal and
 * relaunches `pi --session <file>` on demand.
 *
 *   /park           park now (waits for a running turn to finish)
 *   /park <name>    name the session, then park
 *   /park off       no auto-park for this session
 *   /park on        auto-park again
 *   --park-after N  idle minutes before auto-park (default 60, 0 disables)
 *
 * Auto-park waits until the user, the agent, and any dialog are all idle. Sessions that
 * slack-bridge has connected to Slack or the Pinet mesh never auto-park and get a
 * confirmation on /park: parked, they look disconnected to the broker.
 */

import { parseArgs, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// slack-bridge activates these only while connected (slack-bridge/tool-registration-runtime.ts).
const CONNECTED_TOOL_NAMES = new Set(["slack", "slack_inbox", "slack_send", "pinet", "imessage_send"]);

const AUTO_PARK_TICK_MS = 30_000;
const DEFAULT_PARK_AFTER_MINUTES = "60";

export interface ParkRecord {
	cwd: string;
	title: string;
	sessionFile: string;
	argv: string[];
}

/**
 * Rebuild the command line for `pi --session <file>` from the original invocation.
 * Keeps resource, tool, prompt, and display flags plus extension flags; drops session
 * selection, initial prompts, and one-shot modes. Model and thinking level are pinned to
 * the parked state so a session without messages does not fall back to defaults.
 */
export function relaunchArgs(
	rawArgs: string[],
	sessionFile: string,
	model: { provider: string; id: string } | undefined,
	thinkingLevel: string | undefined,
): string[] {
	const parsed = parseArgs(rawArgs);
	const argv: string[] = [];
	const flag = (name: string, value: string | undefined): void => {
		if (value !== undefined) argv.push(name, value);
	};
	const flags = (name: string, values: string[] | undefined): void => {
		for (const value of values ?? []) argv.push(name, value);
	};
	const list = (name: string, values: string[] | undefined): void => {
		if (values && values.length > 0) argv.push(name, values.join(","));
	};
	const bool = (name: string, value: boolean | undefined): void => {
		if (value) argv.push(name);
	};

	if (model) flag("--model", `${model.provider}/${model.id}`);
	flag("--thinking", thinkingLevel);
	flag("--api-key", parsed.apiKey);
	flag("--system-prompt", parsed.systemPrompt);
	flags("--append-system-prompt", parsed.appendSystemPrompt);
	flag("--session-dir", parsed.sessionDir);
	list("--models", parsed.models);
	list("--tools", parsed.tools);
	list("--exclude-tools", parsed.excludeTools);
	bool("--no-tools", parsed.noTools);
	bool("--no-builtin-tools", parsed.noBuiltinTools);
	flags("--extension", parsed.extensions);
	bool("--no-extensions", parsed.noExtensions);
	flags("--skill", parsed.skills);
	bool("--no-skills", parsed.noSkills);
	flags("--prompt-template", parsed.promptTemplates);
	bool("--no-prompt-templates", parsed.noPromptTemplates);
	flags("--theme", parsed.themes);
	flag("--use-theme", parsed.useTheme);
	bool("--no-themes", parsed.noThemes);
	bool("--no-context-files", parsed.noContextFiles);
	bool("--offline", parsed.offline);
	flag("--tui-mode", parsed.tuiMode);
	bool("--verbose", parsed.verbose);
	if (parsed.projectTrustOverride === true) argv.push("--approve");
	if (parsed.projectTrustOverride === false) argv.push("--no-approve");
	for (const [name, value] of parsed.unknownFlags) {
		if (value === true) argv.push(`--${name}`);
		else if (typeof value === "string") argv.push(`--${name}`, value);
	}
	// Last on purpose: the wrapper reads the record with `$(<file)`, which strips trailing
	// newlines, so the final field must be one that never ends with a newline.
	argv.push("--session", sessionFile);
	return argv;
}

/** NUL-separated, no trailing NUL: cwd, title, sessionFile, argv... (see bin/pi-wrapper). */
export function encodeParkRecord(record: ParkRecord): string {
	return [record.cwd, record.title, record.sessionFile, ...record.argv].join("\0");
}

export function decodeParkRecord(text: string): ParkRecord {
	const [cwd, title, sessionFile, ...argv] = text.split("\0");
	return { cwd, title, sessionFile, argv };
}

export default feature(import.meta.url, (pi: ExtensionAPI) => {
	const parkFile = process.env.PI_PARK_FILE;
	// Only the pi the wrapper launched may write the wrapper's record: nested pi processes
	// inherit the environment but have a different parent.
	if (parkFile === undefined || process.env.PI_PARK_WRAPPER_PID !== String(process.ppid)) {
		pi.registerCommand("park", {
			description: "Explain how to enable idle parking",
			handler: async (_args, ctx) => {
				const launcher = fileURLToPath(new URL("../scripts/pi-park", import.meta.url));
				ctx.ui.notify(`Idle parking is off because Pi was started without its launcher. Restart with ${launcher}. Use the shell alias in the Vibes README to keep it enabled.`, "warning");
			},
		});
		return;
	}
	const draftFile = `${parkFile}.draft`;

	pi.registerFlag("park-after", {
		description: `Park automatically after this many idle minutes (default ${DEFAULT_PARK_AFTER_MINUTES}, 0 disables)`,
		type: "string",
		default: DEFAULT_PARK_AFTER_MINUTES,
	});

	let lastActivity = Date.now();
	let agentRunning = false;
	let promptOpen = false;
	let parking = false;
	let autoPark = true;
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribeInput: (() => void) | undefined;

	const touch = (): void => {
		lastActivity = Date.now();
	};

	const connected = (): boolean => pi.getActiveTools().some((name) => CONNECTED_TOOL_NAMES.has(name));

	const park = (ctx: ExtensionContext): void => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile === undefined) return;
		parking = true;
		const record: ParkRecord = {
			cwd: ctx.cwd,
			title: pi.getSessionName() ?? basename(ctx.cwd),
			sessionFile,
			argv: relaunchArgs(process.argv.slice(2), sessionFile, ctx.model, pi.getThinkingLevel()),
		};
		const draft = ctx.ui.getEditorText();
		if (draft) writeFileSync(draftFile, draft);
		writeFileSync(parkFile, encodeParkRecord(record));
		ctx.shutdown();
	};

	const stopWatching = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
	};

	const tick = (ctx: ExtensionContext, thresholdMs: number): void => {
		if (!autoPark || parking || agentRunning || promptOpen || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (Date.now() - lastActivity < thresholdMs) return;
		if (ctx.sessionManager.getSessionFile() === undefined || connected()) return;
		park(ctx);
	};

	pi.registerCommand("park", {
		description: "Park now (keeps the transcript on screen; any key wakes it). /park off|on toggles auto-park",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			const name = args.trim();
			if (name === "off" || name === "on") {
				autoPark = name === "on";
				ctx.ui.notify(autoPark ? "Auto-park on" : "Auto-park off for this session", "info");
				return;
			}
			if (ctx.sessionManager.getSessionFile() === undefined) {
				ctx.ui.notify("This session is not persisted (--no-session), so it cannot be parked", "error");
				return;
			}
			if (connected()) {
				const proceed = await ctx.ui.confirm(
					"Park a connected session?",
					"This session is connected to Slack or the Pinet mesh. While parked it looks disconnected: scheduled wake-ups will not reach it and the broker may reassign its threads.",
				);
				if (!proceed) return;
			}
			if (name) pi.setSessionName(name);
			if (!ctx.isIdle()) {
				ctx.ui.notify("Parking once the agent finishes", "info");
				await ctx.waitForIdle();
			}
			if (ctx.hasPendingMessages()) {
				ctx.ui.notify("Queued messages are waiting, so Pi was not parked", "warning");
				return;
			}
			park(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		stopWatching();
		parking = false;
		touch();
		if (ctx.mode !== "tui") return;
		if (existsSync(draftFile)) {
			ctx.ui.setEditorText(readFileSync(draftFile, "utf8"));
			unlinkSync(draftFile);
		}
		unsubscribeInput = ctx.ui.onTerminalInput(() => {
			touch();
			return undefined;
		});
		const minutes = Number(pi.getFlag("park-after") ?? DEFAULT_PARK_AFTER_MINUTES);
		if (Number.isFinite(minutes) && minutes > 0) {
			timer = setInterval(() => tick(ctx, minutes * 60_000), AUTO_PARK_TICK_MS);
		}
	});
	pi.on("session_shutdown", () => stopWatching());
	pi.on("input", () => touch());
	pi.on("agent_start", () => {
		agentRunning = true;
	});
	pi.on("agent_settled", () => {
		agentRunning = false;
		touch();
	});
	pi.on("ui_prompt_start", () => {
		promptOpen = true;
	});
	pi.on("ui_prompt_end", () => {
		promptOpen = false;
		touch();
	});
});
