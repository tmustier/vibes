// scripts/migrate-voice-settings.mjs: Codex Conversion's voice settings reach GipPity Control once.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateVoiceSettings } from "../scripts/migrate-voice-settings.mjs";

const dir = mkdtempSync(join(tmpdir(), "migrate-voice-"));
const source = join(dir, "pi-codex-conversion.json");
const target = join(dir, "pi-gippity-control.json");
const voice = { v3Voice: "cove", realtimeShortcut: "ctrl+alt+v", inputDevice: "coreaudio:Headset", taskDelegationReasoning: "medium" };
try {
	assert.equal(migrateVoiceSettings(dir), undefined, "no Codex Conversion settings: nothing to do");
	assert.equal(existsSync(target), false);

	writeFileSync(source, JSON.stringify({ voiceFeaturesOnly: true, tools: { webRun: false } }));
	assert.equal(migrateVoiceSettings(dir), undefined, "no voice settings: nothing to do");
	assert.equal(existsSync(target), false);

	const original = JSON.stringify({ voiceFeaturesOnly: true, voice, tools: { webRun: false } });
	writeFileSync(source, original);
	assert.equal(migrateVoiceSettings(dir), target);
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { voice }, "only the voice settings move");
	assert.equal(readFileSync(source, "utf8"), original, "Codex Conversion's file is left alone");

	writeFileSync(target, JSON.stringify({ voice: { v3Voice: "juniper" } }));
	assert.equal(migrateVoiceSettings(dir), undefined, "GipPity settings exist: they stay the user's");
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { voice: { v3Voice: "juniper" } });

	// A file only Vibes has written (the delegation keys) still gets the copy; the model Vibes set stays.
	writeFileSync(target, JSON.stringify({ voice: { taskDelegationModel: "openai-codex/gpt-6.1-sol", taskDelegationReasoning: "medium" } }));
	assert.equal(migrateVoiceSettings(dir), target);
	assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { voice: { ...voice, taskDelegationModel: "openai-codex/gpt-6.1-sol" } }, "reasoning the user chose in Codex Conversion stays");
	assert.equal(migrateVoiceSettings(dir), undefined, "once copied, the file is GipPity's");

	rmSync(target);
	const out = execFileSync("node", [new URL("../scripts/migrate-voice-settings.mjs", import.meta.url).pathname, dir], { encoding: "utf8" });
	assert.match(out, /Copied realtime voice settings/, "CLI reports the copy");
	assert.equal(execFileSync("node", [new URL("../scripts/migrate-voice-settings.mjs", import.meta.url).pathname, dir], { encoding: "utf8" }), "", "CLI is quiet once done");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log("ok");
