#!/usr/bin/env node
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { featureDefaults, isFeature, readFeatureConfig } from "../lib/features.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const configPath = join(agentDir, "vibes.json");
const settingsPath = join(agentDir, "settings.json");

try {
	const choices = readFeatureConfig(configPath);
	const [command, ...args] = process.argv.slice(2);
	if (!command) {
		console.log(`${configPath} (Pi filters and separate copies still apply)`);
		for (const name of Object.keys(featureDefaults).sort()) {
			console.log(`${name}: ${(choices[name] ?? featureDefaults[name]) ? "on" : "off"} (${Object.hasOwn(choices, name) ? "personal" : "default"})`);
		}
		process.exit(0);
	}
	assert.equal(command, "migrate", "usage: vibes features [migrate [--apply] [--source <source>]]");
	const { values: { apply, source } } = parseArgs({ args, options: {
		apply: { type: "boolean", default: false },
		source: { type: "string", default: "git:github.com/tmustier/vibes" },
	} });
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert(Array.isArray(settings.packages), "settings.json must contain a packages array");
	const packages = settings.packages.filter((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === source);
	assert(packages.length, `No personal package entry for '${source}'; pass its exact --source`);
	const migrated = [];
	const retained = [];
	for (const pkg of packages) {
		if (typeof pkg === "string" || pkg.extensions === undefined) continue;
		assert(Array.isArray(pkg.extensions) && pkg.extensions.every((item) => typeof item === "string"), "Vibes extensions must be a string array");
		if (!pkg.extensions.length || pkg.extensions.some((item) => !/^[!-]/.test(item))) {
			retained.push("native selection list");
			continue;
		}
		pkg.extensions = pkg.extensions.filter((filter) => {
			const name = /^[!-](?:\.\/)?extensions\/([a-z0-9-]+)\.ts$/.exec(filter)?.[1];
			if (!name || !isFeature(name)) { retained.push(filter); return true; }
			assert(choices[name] !== true, `Cannot migrate ${filter}: vibes.json explicitly enables '${name}'; resolve this choice first`);
			choices[name] = false;
			migrated.push(name);
			return false;
		});
		if (!pkg.extensions.length) delete pkg.extensions;
	}
	console.log(`Move to personal opt-outs: ${migrated.join(", ") || "none"}`);
	if (retained.length) console.log(`Retained for manual review: ${retained.join(", ")}`);
	if (!apply || !migrated.length) {
		console.log(apply ? "Nothing to migrate; no files written." : "Preview only. Close Pi and rerun with --apply. No files written.");
		process.exit(0);
	}
	const backup = join(agentDir, `vibes-feature-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	mkdirSync(backup, { mode: 0o700 });
	copyFileSync(settingsPath, join(backup, "settings.json"));
	if (existsSync(configPath)) copyFileSync(configPath, join(backup, "vibes.json"));
	else writeFileSync(join(backup, "vibes.json.absent"), "vibes.json did not exist before migration.\n");
	// Write choices first so an interrupted migration cannot re-enable an excluded wrapper.
	for (const [path, value] of [[configPath, { features: choices }], [settingsPath, settings]]) {
		writeFileSync(`${path}.vibes-tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
		renameSync(`${path}.vibes-tmp`, path);
	}
	console.log(`Applied. Backups: ${backup}. Restart Pi and run vibes check.`);
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
