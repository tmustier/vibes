import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibes-features-cli-"));
const settingsPath = path.join(scratch, "settings.json");
const configPath = path.join(scratch, "vibes.json");
const env = { ...process.env, PI_CODING_AGENT_DIR: scratch };
const source = "git:github.com/tmustier/vibes@feature-test";
const cli = (...args) => execFileSync("bash", [path.join(root, "scripts/vibes"), "features", ...args], { env, encoding: "utf8" });
try {
	const extras = { source: "git/github.com/tmustier/vibes/node_modules/pi-extensions", extensions: ["desktop/index.ts"], skills: [] };
	const observers = { source: "git/github.com/tmustier/vibes/node_modules/pine-of-glass", extensions: ["extensions/pi-cachemire/index.ts", "extensions/pi-meantime/index.ts"] };
	const settings = { defaultModel: "personal", packages: [
		{ source, extensions: ["!extensions/surf.ts", "-extensions/session-hud.ts", "!extensions/future*.ts"], prompts: ["!prompts/onboard.md"] },
		extras, observers, "git:github.com/me/fork",
	] };
	const config = { features: { cachemire: true } };
	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	fs.writeFileSync(configPath, JSON.stringify(config));
	assert.match(cli(), /cachemire: on \(personal\)/);
	assert.match(cli(), /amp-orbs: off \(default\)/);
	assert.match(cli(), /anthropic-gzip: on \(default\)/);
	fs.writeFileSync(configPath, JSON.stringify({ features: { "anthropic-gzip": false } }));
	assert.match(cli(), /anthropic-gzip: off \(personal\)/);
	fs.writeFileSync(configPath, JSON.stringify({ features: { "amp-orbs": true } }));
	assert.match(cli(), /amp-orbs: on \(personal\)/);
	fs.writeFileSync(configPath, JSON.stringify(config));
	assert.match(cli("migrate", "--source", source), /Preview only/);
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)), settings);
	assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), config);
	assert.match(cli("migrate", "--source", source, "--apply"), /Applied\. Backups:/);
	assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { features: { cachemire: true, surf: false, "session-hud": false } });
	const migrated = JSON.parse(fs.readFileSync(settingsPath));
	assert.deepEqual(migrated.packages[0], { source, extensions: ["!extensions/future*.ts"], prompts: ["!prompts/onboard.md"] });
	assert.deepEqual(migrated.packages.slice(1), settings.packages.slice(1));
	assert.equal(migrated.defaultModel, "personal");
	const backup = fs.readdirSync(scratch).find((name) => name.startsWith("vibes-feature-backup-"));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch, backup, "settings.json"))), settings);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(scratch, backup, "vibes.json"))), config);
	assert.match(cli("migrate", "--source", source, "--apply"), /Nothing to migrate/);

	for (const extensions of [[], ["extensions/surf.ts"], ["+extensions/surf.ts", "!extensions/surf.ts"], ["!extensions/*.ts"]]) {
		const original = { packages: [{ source, extensions }] };
		fs.writeFileSync(settingsPath, JSON.stringify(original));
		cli("migrate", "--source", source, "--apply");
		assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)), original, "complex native selections must remain unchanged");
	}

	fs.writeFileSync(settingsPath, JSON.stringify(settings));
	fs.writeFileSync(configPath, JSON.stringify({ features: { surf: true } }));
	const conflict = spawnSync("bash", [path.join(root, "scripts/vibes"), "features", "migrate", "--source", source, "--apply"], { env, encoding: "utf8" });
	assert.notEqual(conflict.status, 0);
	assert.match(conflict.stderr, /explicitly enables 'surf'/);
	assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath)), settings, "a conflict must not write settings");
	assert.deepEqual(JSON.parse(fs.readFileSync(configPath)), { features: { surf: true } });

	for (const [value, message] of [
		['{"features":{"cashemire":true}}', /Unknown Vibes feature 'cashemire'/],
		['{"features":{"surf":"false"}}', /must be true or false/],
		['{"features":[]}', /boolean map/],
		['{"feature":{}}', /Only the features key/],
		['{', /vibes.json/],
	]) {
		fs.writeFileSync(configPath, value);
		const invalid = spawnSync("bash", [path.join(root, "scripts/vibes"), "features"], { env, encoding: "utf8" });
		assert.notEqual(invalid.status, 0);
		assert.match(invalid.stderr, message);
	}
	console.log("ok: CLI preview/apply, preserved settings and copies, backups, conflicts, invalid config and idempotence");
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
