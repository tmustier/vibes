// Realtime voice's task delegation model follows the Vibes template unless the user chose their own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const team = { taskDelegationModel: "openai-codex/gpt-6.1-sol", taskDelegationReasoning: "medium" };
const gippityDefault = { taskDelegationModel: "openai-codex/gpt-6-luna", taskDelegationReasoning: "low" };
assert.deepEqual(JSON.parse(readFileSync("pi-gippity-control.template.json", "utf8")), { voice: team });
const root = mkdtempSync(join(tmpdir(), "vibes-voice-settings-"));
const write = (path, value) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
};
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
try {
	const previous = join(root, "previous");
	const vibes = join(root, "vibes");
	const agent = join(root, "agent");
	const config = join(agent, "pi-gippity-control.json");
	mkdirSync(previous);
	write(join(vibes, "pi-gippity-control.template.json"), { voice: team });
	const sync = () => execFileSync(process.execPath, ["scripts/sync-settings.mjs", previous, vibes, agent], { env: { ...process.env, VIBES_UPDATE_LOCKED: "" } });
	const devices = { inputDevice: "coreaudio:Headset", v3Voice: "cove" };

	// First update with the template: no file, or GipPity's own default written out by /gippity, moves to the team's.
	sync();
	assert.deepEqual(read(config), { voice: team });
	write(config, { lan: { port: 43120 }, voice: { ...devices, ...gippityDefault } });
	sync();
	assert.deepEqual(read(config), { lan: { port: 43120 }, voice: { ...devices, ...team } }, "other settings stay");

	// A model the user chose stays theirs, on the first update and later ones.
	const own = { taskDelegationModel: "anthropic/claude-opus-5-5", taskDelegationReasoning: "high" };
	write(config, { voice: { ...devices, ...own } });
	sync();
	assert.deepEqual(read(config), { voice: { ...devices, ...own } });
	write(join(previous, "pi-gippity-control.template.json"), { voice: team });
	sync();
	assert.deepEqual(read(config), { voice: { ...devices, ...own } });

	// Once the template has shipped, choosing GipPity's default again is a choice too.
	write(config, { voice: { ...devices, ...gippityDefault } });
	sync();
	assert.deepEqual(read(config), { voice: { ...devices, ...gippityDefault } });

	// sync-settings copies Codex Conversion's voice settings first, so the copy is not skipped.
	rmSync(config);
	write(join(agent, "pi-codex-conversion.json"), { voiceFeaturesOnly: true, voice: { ...devices, ...gippityDefault } });
	rmSync(join(previous, "pi-gippity-control.template.json"));
	sync();
	assert.deepEqual(read(config), { voice: { ...devices, ...team } });
	assert.ok(existsSync(join(agent, "pi-codex-conversion.json")));
	assert.doesNotMatch(readFileSync("scripts/vibes", "utf8"), /migrate-voice-settings/, "one copy step, which a hotfix's previous script also runs");

	// The 25 November hotfix ran the sync before the copy, leaving only the delegation keys. The copy repairs that.
	write(config, { voice: team });
	sync();
	assert.deepEqual(read(config), { voice: { ...devices, ...team } });
	// A delegation model the user chose in Codex Conversion wins over the one Vibes set.
	write(join(agent, "pi-codex-conversion.json"), { voice: { ...devices, ...own } });
	write(config, { voice: team });
	sync();
	assert.deepEqual(read(config), { voice: { ...devices, ...own } });
} finally {
	rmSync(root, { recursive: true, force: true });
}
