export type FastMode = "off" | "fast" | "ultrafast";
/** Slowest first. */
export const FAST_MODES: readonly FastMode[] = ["off", "fast", "ultrafast"];
/** Compaction speed until `/fast compaction` sets one. */
export const DEFAULT_COMPACTION_MODE: FastMode = "fast"; // agent-default (not a user rule): 2026-10-14

export const faster = (a: FastMode, b: FastMode): FastMode => (FAST_MODES.indexOf(a) >= FAST_MODES.indexOf(b) ? a : b);

export type FastOption =
	| { value: "off"; label: "Standard"; patch?: never; beta?: never }
	| { value: "fast"; label: "Fast"; patch: { service_tier: "priority"; speed?: never }; beta?: never }
	| { value: "fast"; label: "Fast"; patch: { speed: "fast"; service_tier?: never }; beta: "fast-mode-2026-02-01" }
	| { value: "ultrafast"; label: "Ultrafast"; patch: { service_tier: "ultrafast"; speed?: never }; beta?: never };

/** The exact speed `mode` on `model`, if the model supports it. */
export const fastOption = (model: { api: string; id: string } | undefined, mode: FastMode): FastOption | undefined => fastOptions(model).find((option) => option.value === mode);

/** The fastest speed `model` supports that is no faster than `mode`. */
export const fastOptionUpTo = (model: { api: string; id: string } | undefined, mode: FastMode): FastOption | undefined => fastOptions(model).filter((option) => faster(mode, option.value) === mode).at(-1);

/** The speeds `model` supports, standard first. Empty when it supports no accelerated processing. */
export function fastOptions(model: { api: string; id: string } | undefined): FastOption[] {
	const standard: FastOption = { value: "off", label: "Standard" };
	if (model?.api === "openai-responses" || model?.api === "openai-codex-responses") {
		const options: FastOption[] = [standard, { value: "fast", label: "Fast", patch: { service_tier: "priority" } }];
		if (model.id === "gpt-6-astra" || model.id === "gpt-6.1-sol") options.push({ value: "ultrafast", label: "Ultrafast", patch: { service_tier: "ultrafast" } });
		return options;
	}
	if (model?.api === "anthropic-messages" && model.id.includes("claude-opus-4-6")) {
		return [standard, { value: "fast", label: "Fast", patch: { speed: "fast" }, beta: "fast-mode-2026-02-01" }];
	}
	return [];
}
