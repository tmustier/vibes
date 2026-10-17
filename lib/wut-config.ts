import { readFileSync } from "node:fs";

export const defaultObserverModels = ["openai-codex/gpt-6-luna", "openai/gpt-6-luna"];

/** An explicit list replaces the defaults, including the implicit session-model fallback. */
export function readObserverConfig(path: string): { models: string[]; useSessionFallback: boolean } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { models: defaultObserverModels, useSessionFallback: true };
		}
		throw error;
	}
	try {
		const value = JSON.parse(text);
		if (!value || typeof value !== "object" || Array.isArray(value) ||
			Object.keys(value).some((key) => key !== "models") ||
			!Array.isArray(value.models) || value.models.length === 0 ||
			!value.models.every((model: unknown) => typeof model === "string" && /^[^/\s]+\/\S+$/.test(model))) {
			throw new Error('Expected { "models": ["provider/model-id", ...] } with at least one model');
		}
		return { models: [...new Set<string>(value.models)], useSessionFallback: false };
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : error}`);
	}
}
