#!/usr/bin/env node
// Carries realtime voice settings from Codex Conversion to GipPity Control, once.
// Vibes bundled Codex Conversion for voice until it dropped its voice-only mode; GipPity Control
// now provides the same voice controls with the same `voice` settings (devices, shortcuts, voices,
// delegation model). sync-settings.mjs runs this before it applies pi-gippity-control.template.json.
// The copy runs while GipPity's file is missing or holds only the delegation keys that template
// sets: GipPity itself writes every setting, so such a file has only ever been written by Vibes.
// pi-codex-conversion.json stays as it is for anyone who installs Codex Conversion themselves.
//   node scripts/migrate-voice-settings.mjs <agent dir>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GIPPITY_DEFAULT = { taskDelegationModel: "openai-codex/gpt-6-luna", taskDelegationReasoning: "low" };

export function migrateVoiceSettings(agentDir) {
	const target = join(agentDir, "pi-gippity-control.json");
	const source = join(agentDir, "pi-codex-conversion.json");
	if (!existsSync(source)) return undefined;
	const current = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};
	const onlyVibes = Object.keys(current).every((key) => key === "voice") &&
		Object.keys(current.voice ?? {}).every((key) => key in GIPPITY_DEFAULT);
	if (!onlyVibes) return undefined;
	const { voice } = JSON.parse(readFileSync(source, "utf8"));
	if (!voice || typeof voice !== "object") return undefined;
	// A delegation model Vibes already set stays, unless the user had chosen their own in Codex Conversion.
	const merged = { ...voice };
	for (const [key, value] of Object.entries(GIPPITY_DEFAULT)) {
		if (current.voice?.[key] !== undefined && (voice[key] === undefined || voice[key] === value)) merged[key] = current.voice[key];
	}
	writeFileSync(target, `${JSON.stringify({ voice: merged }, null, 2)}\n`);
	return target;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const target = migrateVoiceSettings(process.argv[2]);
	if (target) console.log(`Copied realtime voice settings from pi-codex-conversion.json to ${target}`);
}
