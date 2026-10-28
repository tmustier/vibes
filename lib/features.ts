import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

export const featureDefaults = {
	// agent-default (not a user rule): 2026-10-16. Compress eligible Anthropic uploads.
	"anthropic-gzip": true,
	browser: true,
	"claude-artifacts": true,
	"code-actions": true,
	"computer-use": true,
	contextimate: true,
	"continue-shortcut": true,
	"extending-pi": true,
	"fast-mode": true,
	"files-widget": true,
	goal: true,
	imagegen: true,
	inventory: true,
	"non-interactive-bash": true,
	notify: true,
	open: true,
	papercut: true,
	park: true,
	"queue-steer": true,
	"radius-api": true,
	"raw-paste": true,
	"read-agent-instructions": true,
	"realtime-voice": true,
	"send-approval": true,
	"session-hud": true,
	subagents: true,
	surf: true,
	tips: true,
	tmux: true,
	traceline: true,
	"update-status": true,
	usage: true,
	"vibes-check": true,
	voice: true,
	"web-access": true,
	"you-should-know": true,
	whimsical: true,
	wut: true,
	"amp-orbs": false,
	cachemire: false,
	meantime: false,
} as const;

type FeatureName = keyof typeof featureDefaults;

export function isFeature(name: string): name is FeatureName {
	return Object.hasOwn(featureDefaults, name);
}

export function readFeatureConfig(path: string): Partial<Record<FeatureName, boolean>> {
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		assert(value && typeof value === "object" && !Array.isArray(value), "Expected a features object");
		assert(Object.keys(value).every((key) => key === "features"), "Only the features key is supported");
		const features = "features" in value ? value.features : {};
		assert(features && typeof features === "object" && !Array.isArray(features), "features must be a boolean map");
		const choices: Partial<Record<FeatureName, boolean>> = {};
		for (const [name, enabled] of Object.entries(features)) {
			assert(isFeature(name), `Unknown Vibes feature '${name}'; run vibes features to list names`);
			assert(typeof enabled === "boolean", `Vibes feature '${name}' must be true or false`);
			choices[name] = enabled;
		}
		return choices;
	} catch (error) {
		throw new Error(`${path}: ${error}`);
	}
}
