import { feature } from "../lib/feature.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_MODE, FAST_MODES, faster, fastOption, fastOptionUpTo, fastOptions, type FastMode, type FastOption } from "../lib/fast-mode.ts";

const menuEvent = "pi-session-hud:chrome-menu:v1";
const isMode = (value: unknown): value is FastMode => value === "off" || value === "fast" || value === "ultrafast";
const speedLabel = "vibes.speed";
type SentSpeed = { provider: string; model: string; speed: "standard" | "fast" | "ultrafast" };
const describe = (option: FastOption | undefined) => option?.patch ? Object.entries(option.patch).map(([key, value]) => `${key}=${value}`).join("; ") : "inactive";

export function fastMode(pi: ExtensionAPI, stream = streamSimple) {
	let mode: FastMode = "off";
	let compaction: FastMode | undefined; // Unset means `DEFAULT_COMPACTION_MODE`.
	let compacting: { sent?: SentSpeed } | undefined;
	let active = true;
	let lastTurn: SentSpeed | undefined;
	// Compaction never runs slower than the turns: a faster `/fast` raises it, and a model
	// without the requested speed gets the fastest one it has.
	const compactionSpeed = (model: { api: string; id: string } | undefined) => fastOptionUpTo(model, faster(compaction ?? DEFAULT_COMPACTION_MODE, mode));
	const speed = (model: { api: string; id: string } | undefined) => (compacting ? compactionSpeed(model) : fastOption(model, mode));
	for (const [provider, api] of Object.entries({
		"openai-codex": "openai-codex-responses",
		openai: "openai-responses",
		anthropic: "anthropic-messages",
	} as const)) {
		pi.registerProvider(provider, {
			api,
			streamSimple: (model, context, options) => {
				const option = active ? speed(model) : undefined;
				const sent: SentSpeed | undefined = active && fastOptions(model).length
					? { provider: model.provider, model: model.id, speed: option?.patch ? option.value : "standard" }
					: undefined;
				if (compacting) compacting.sent = sent;
				else lastTurn = sent;
				const patch = option?.patch;
				if (!patch) return stream(model, context, options);
				return stream(model, context, { ...options, onPayload: async (body, requestModel) => {
					const payload = await options?.onPayload?.(body, requestModel) ?? body;
					assert(payload && typeof payload === "object", "Expected a provider request object");
					return { ...payload, ...patch };
				} });
			},
		});
	}
	pi.on("before_provider_headers", (event, ctx) => {
		const beta = active ? speed(ctx.model)?.beta : undefined;
		if (!beta) return;
		const existing = (event.headers["anthropic-beta"] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
		event.headers["anthropic-beta"] = [...new Set([...existing, beta])].join(",");
	});
	// `/reload` keeps the provider layer registered; the replacement instance registers over it.
	pi.on("session_shutdown", () => { active = false; });

	pi.on("session_start", (_event, ctx) => {
		active = true;
		if (pi.getCommands().some(({ name, source }) => name === "fast" && source === "extension")) {
			ctx.ui.notify("Your existing /fast command still owns fast mode. Remove that extension and reload to use Vibes fast mode, including /fast ultrafast.", "warning");
			return;
		}

		const configPath = join(getAgentDir(), "fast-mode.json");
		let reportedTier: string | undefined;
		if (existsSync(configPath)) {
			try {
				const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
				assert(config && typeof config === "object" && !Array.isArray(config), "Expected a fast-mode configuration object");
				let savedMode = "mode" in config ? config.mode : undefined;
				if (savedMode === undefined) savedMode = "enabled" in config && config.enabled === true ? "fast" : "off";
				const savedCompaction = "compaction" in config ? config.compaction : undefined;
				assert(isMode(savedMode), "Unknown fast-mode setting");
				assert(savedCompaction === undefined || isMode(savedCompaction), "Unknown fast-mode compaction setting");
				mode = savedMode;
				compaction = savedCompaction;
			} catch (error) {
				ctx.ui.notify(`Could not read fast-mode.json; fast mode is off. ${error}`, "warning");
			}
		}

		const refresh = (): void => {
			const options = fastOptions(ctx.model);
			const current = fastOption(ctx.model, mode)?.patch;
			const suffix = !current ? " n/a" : reportedTier ? ` (reported: ${reportedTier})` : "";
			ctx.ui.setStatus("fast-mode", mode === "off" ? undefined
				: ctx.ui.theme.fg(current && (!reportedTier || current.service_tier === reportedTier) ? "accent" : "warning", "⚡")
					+ ctx.ui.theme.fg("dim", ` ${mode}${suffix}`));
			if (!options.length) {
				pi.events.emit(menuEvent, { protocolVersion: 1, id: "fast-mode", remove: true });
				return;
			}
			pi.events.emit(menuEvent, {
				protocolVersion: 1,
				id: "fast-mode",
				label: mode === "off" ? "standard" : current ? `↯ ${mode}` : `${mode} n/a`,
				title: "Speed",
				current: mode,
				items: options,
				onClick: () => {
					const choices = fastOptions(ctx.model);
					if (choices.length) save({ mode: choices[(choices.findIndex(({ value }) => value === mode) + 1) % choices.length]!.value });
				},
				onSelect: (value: string) => {
					const choice = fastOptions(ctx.model).find((option) => option.value === value);
					if (!choice) ctx.ui.notify(`${value} is not supported by ${ctx.model?.id ?? "the current model"}.`, "warning");
					else if (choice.value !== mode) save({ mode: choice.value });
				},
			});
		};
		const save = (next: { mode: FastMode; compaction?: never } | { compaction: FastMode | undefined; mode?: never }): void => {
			if (next.mode !== undefined) { mode = next.mode; reportedTier = undefined; }
			else compaction = next.compaction;
			mkdirSync(dirname(configPath), { recursive: true });
			writeFileSync(configPath, JSON.stringify({ mode, enabled: mode !== "off", compaction }, null, 2) + "\n");
			refresh();
		};
		refresh();
		const unsubscribe = pi.events.on("pi-session-hud:chrome-menu-request:v1", refresh);
		pi.on("message_end", ({ message }) => {
			if (message.role !== "assistant" || lastTurn?.provider !== message.provider || lastTurn.model !== message.model) return;
			const { speed } = lastTurn;
			lastTurn = undefined;
			return { message: { ...message, diagnostics: [...(message.diagnostics ?? []), { type: speedLabel, timestamp: Date.now(), details: { speed } }] } };
		});
		pi.on("session_before_compact", () => { compacting = {}; });
		pi.on("session_compact", ({ compactionEntry }) => {
			if (compacting?.sent) pi.appendEntry(speedLabel, { targetId: compactionEntry.id, ...compacting.sent });
			compacting = undefined;
		});
		pi.on("session_compact_failed", () => { compacting = undefined; });
		pi.on("session_shutdown", () => {
			unsubscribe();
			pi.events.emit(menuEvent, { protocolVersion: 1, id: "fast-mode", remove: true });
		});
		pi.on("model_select", () => {
			reportedTier = undefined;
			refresh();
		});
		pi.on("provider_stream_event", (event) => {
			if (event.provider !== ctx.model?.provider || event.model !== ctx.model.id || !fastOption(ctx.model, mode)?.patch?.service_tier) return;
			const data = event.data;
			assert(data && typeof data === "object", "Expected an OpenAI stream event object");
			if (!("type" in data) || data.type !== "response.completed") return;
			assert("response" in data && data.response && typeof data.response === "object", "Expected a completed response");
			if (!("service_tier" in data.response) || typeof data.response.service_tier !== "string") return;
			reportedTier = data.response.service_tier;
			refresh();
		});
		pi.registerCommand("fast", {
			description: "Toggle fast mode, or select on|off|ultrafast|status|compaction <off|fast|ultrafast|default>",
			getArgumentCompletions: (prefix) => {
				const words = prefix.trimStart().toLowerCase().split(/\s+/);
				const choices = words.length > 1 ? (words[0] === "compaction" ? [...FAST_MODES, "default"] : []) : ["on", "off", "ultrafast", "status", "compaction"];
				const matches = choices.filter((arg) => arg.startsWith(words.at(-1)!)).map((value) => ({ value: words.length > 1 ? `compaction ${value}` : value, label: value }));
				return matches.length ? matches : null;
			},
			handler: async (args) => {
				const [command = "", argument, ...rest] = args.trim().toLowerCase().split(/\s+/);
				if (rest.length || (command === "compaction"
					? argument !== "default" && !isMode(argument)
					: argument || !["", "on", "status", ...FAST_MODES].includes(command))) {
					ctx.ui.notify("Usage: /fast [on|off|ultrafast|status|compaction <off|fast|ultrafast|default>]", "warning");
					return;
				}
				if (command === "") save({ mode: mode === "off" ? "fast" : "off" });
				else if (command === "on") save({ mode: "fast" });
				else if (isMode(command)) save({ mode: command });
				else if (command === "compaction" && argument === "default") save({ compaction: undefined });
				else if (command === "compaction" && isMode(argument)) save({ compaction: argument });
				const current = fastOption(ctx.model, mode);
				const compactionSetting = compaction ?? DEFAULT_COMPACTION_MODE;
				const raised = faster(compactionSetting, mode) !== compactionSetting;
				ctx.ui.notify([
					`Fast mode: ${mode}.`,
					`Compaction: ${compactionSetting}${compaction ? "" : " (default)"}${raised ? `, raised to ${mode} by fast mode` : ""}.`,
					`Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
					`Request patch: ${describe(current)}`,
					`Compaction patch: ${describe(compactionSpeed(ctx.model))}`,
					`Last reported service tier: ${reportedTier ?? "not yet reported"}`,
					...(faster(compactionSetting, mode) === "ultrafast" ? ["Ultrafast requires an eligible subscription or API access. The reported service tier may remain default even at Ultrafast speeds. Pi's cost estimate does not include Ultrafast pricing."] : []),
				].join("\n"), mode !== "off" && !current ? "warning" : "info");
			},
		});
	});
}

export default feature(import.meta.url, (pi) => fastMode(pi));
