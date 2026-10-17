#!/usr/bin/env node
// Keep the team's model, cache warming, display, compaction, subagent and web-tool settings current on each `vibes update`.
//
//   sync-settings.mjs <previous-templates-dir> <vibes-dir> <agent-dir>
//
// A setting follows the Vibes template unless the user changed it from what the previous
// template set; then it stays theirs. <previous-templates-dir> holds the template files as they
// were before this update installed the new Vibes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { patchRadiusWork } from "../lib/cache-safe-radius-work.mjs";

const SETTINGS_KEYS = [
	"enabledModels",
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"cacheWarming",
	"tuiMode",
	"compaction",
	"subagents",
];

const [previousDir, vibesDir, agentDir] = process.argv.slice(2);

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});

function sync(template, targetPath, keys = null, section = null) {
	let previousRoot = read(join(previousDir, template));
	let nextRoot = read(join(vibesDir, template));
	const targetRoot = read(targetPath);
	if (template === "settings.template.json") {
		// Provider choice is not a template migration: these OAuth grants are not interchangeable.
		const provider = ["openai", "openai-codex"].includes(targetRoot.defaultProvider)
			? targetRoot.defaultProvider
			: targetRoot.enabledModels?.some((model) => model.startsWith("openai/")) ? "openai" : "openai-codex";
		const adapt = (value) => {
			if (typeof value === "string") return value.replace(/^openai(?:-codex)?(?=\/|$)/, provider);
			if (Array.isArray(value)) return value.map(adapt);
			// Sol's 500K metadata override is Codex-only; keep its paired compaction key on that route.
			if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key === "openai-codex/gpt-6.1-sol" ? key : adapt(key), adapt(item)]));
			return value;
		};
		previousRoot = adapt(previousRoot);
		nextRoot = adapt(nextRoot);
	}
	const path = section ? (Array.isArray(section) ? section : [section]) : [];
	const lookup = (root) => path.reduce((value, key) => value?.[key], root) ?? {};
	const previous = lookup(previousRoot);
	const next = lookup(nextRoot);
	const target = lookup(targetRoot);
	const updated = [];
	const kept = [];
	for (const key of keys ?? Object.keys({ ...previous, ...next })) {
		if (isDeepStrictEqual(target[key], next[key])) continue;
		if (key in target && !isDeepStrictEqual(target[key], previous[key])) {
			kept.push(key);
			continue;
		}
		if (key in next) target[key] = next[key];
		else delete target[key];
		updated.push(key);
	}
	if (updated.length > 0) {
		mkdirSync(dirname(targetPath), { recursive: true });
		if (path.length) {
			const parent = path.slice(0, -1).reduce((value, key) => value[key] ??= {}, targetRoot);
			parent[path.at(-1)] = target;
		}
		writeFileSync(targetPath, `${JSON.stringify(targetRoot, null, 2)}\n`);
	}
	console.log(`${targetPath}: ${updated.length ? `updated ${updated.join(", ")}` : "up to date"}`);
	if (kept.length) console.log(`  kept the user's own ${kept.join(", ")}`);
}

sync("settings.template.json", join(agentDir, "settings.json"), SETTINGS_KEYS);
// Sync individual metadata fields, never replace a user's provider or model configuration.
const modelTemplate = "models.template.json";
const previousModels = read(join(previousDir, modelTemplate)).providers ?? {};
const nextModels = read(join(vibesDir, modelTemplate)).providers ?? {};
for (const provider of Object.keys({ ...previousModels, ...nextModels })) {
	const previous = previousModels[provider]?.modelOverrides ?? {};
	const next = nextModels[provider]?.modelOverrides ?? {};
	for (const model of Object.keys({ ...previous, ...next })) {
		sync(modelTemplate, join(agentDir, "models.json"), null, ["providers", provider, "modelOverrides", model]);
	}
}
sync("subagent-config.template.json", join(agentDir, "extensions", "subagent", "config.json"));

// Match pi-web-access's config lookup without shadowing an existing legacy config (and its providers).
function webSearchConfigPath() {
	const agentPath = join(agentDir, "web-search.json");
	if (process.env.PI_CODING_AGENT_DIR) return agentPath;
	const legacyPath = join(dirname(agentDir), "web-search.json");
	if (process.env.XDG_CONFIG_HOME) {
		const xdgPath = join(process.env.XDG_CONFIG_HOME, "pi", "web-search.json");
		return existsSync(xdgPath) ? xdgPath : existsSync(legacyPath) ? legacyPath : xdgPath;
	}
	return existsSync(agentPath) ? agentPath : existsSync(legacyPath) ? legacyPath : agentPath;
}
// Fix the optional known forcing hook before web loading changes; leave unrelated settings independent.
console.log(patchRadiusWork(agentDir));
const webSearchPath = webSearchConfigPath();
sync("web-search.template.json", webSearchPath, ["toolActivation"]);
sync("web-search.template.json", webSearchPath, ["sourceCheck"], "tools");

// Temporary bridge, remove after 2026-10-13 (agent default, not requested): an update run by a
// script from before 2026-09-30 neither hands over to the script it downloads nor installs the
// hourly hotfix job, but it does run this file. So on that night, install the job from here.
if (process.env.VIBES_UPDATE_LOCKED && !process.env.VIBES_UPDATE_CONTINUED) {
	spawnSync("bash", ["-c", 'source "$1" && install_hotfix_job', "_", join(vibesDir, "scripts", "vibes")], { stdio: "inherit" });
}
