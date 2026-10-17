// Public Pi installer + real npm, isolated from user settings/installs and the public registry.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibes-rolling-"));
const owned = ["codex-computer-use-mcp", "@tmustier/pi-session-hud"];
const names = [...owned, "pinned-fixture", "transitive-fixture", "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
const versions = ["1.0.0", "1.0.1"];
const tarballs = new Map();
let latest = versions[0];
const registry = http.createServer((req, res) => {
	const name = decodeURIComponent(req.url.split("?")[0].slice(1));
	if (name.startsWith("tar/")) {
		res.end(tarballs.get(name.slice(4)));
		return;
	}
	if (!names.includes(name)) { res.writeHead(404); res.end("not found"); return; }
	const entries = Object.fromEntries(versions.map((version) => {
		const key = `${name}/${version}`;
		return [version, { name, version, ...(name === "pinned-fixture" ? { dependencies: { "transitive-fixture": "^1.0.0" } } : {}), dist: {
			tarball: `${url}/tar/${encodeURIComponent(key)}`,
			shasum: createHash("sha1").update(tarballs.get(key)).digest("hex"),
		} }];
	}));
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify({ name, "dist-tags": { latest }, versions: entries,
		time: Object.fromEntries(versions.map((version, i) => [version, `2026-01-0${i + 1}T00:00:00.000Z`])) }));
});
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${registry.address().port}`;
const home = path.join(scratch, "home");
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
	npm_config_registry: url, npm_config_cache: path.join(scratch, "cache"), npm_config_audit: "false", npm_config_fund: "false",
	GIT_CONFIG_GLOBAL: path.join(scratch, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
const run = async (command, args, cwd = scratch) => {
	try { return await exec(command, args, { cwd, env, timeout: 60000 }); }
	catch (error) { throw new Error(`${command} ${args.join(" ")}\n${error.stdout}\n${error.stderr}`, { cause: error }); }
};
try {
	for (const name of names) for (const version of versions) {
		const dir = path.join(scratch, "pack", "package");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version,
			...(name === "pinned-fixture" ? { dependencies: { "transitive-fixture": "^1.0.0" } } : {}) }));
		const tar = path.join(scratch, "pack.tgz");
		await run("tar", ["-czf", tar, "-C", path.dirname(dir), "package"]);
		tarballs.set(`${name}/${version}`, fs.readFileSync(tar));
	}
	const sourceRepo = path.join(scratch, "source");
	fs.mkdirSync(sourceRepo);
	const manifest = { name: "vibes-rolling-fixture", private: true, dependencies: {
		[owned[0]]: "latest", [owned[1]]: "latest", "pinned-fixture": "1.0.0",
	}, devDependencies: { "@earendil-works/pi-coding-agent": "1.0.0", "@earendil-works/pi-ai": "1.0.0" } };
	fs.writeFileSync(path.join(sourceRepo, "package.json"), JSON.stringify(manifest));
	fs.writeFileSync(path.join(sourceRepo, "AGENTS.template.md"), "# Shared guidance\n");
	fs.writeFileSync(path.join(sourceRepo, ".npmrc"), "legacy-peer-deps=true\n");
	fs.writeFileSync(path.join(sourceRepo, ".gitignore"), "node_modules/\n");
	await run("npm", ["install", "--package-lock-only"], sourceRepo);
	await run("git", ["init", "-q"], sourceRepo);
	await run("git", ["add", "."], sourceRepo);
	await run("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], sourceRepo);
	const source = "git:https://github.com/vibes-test/rolling";
	await run("git", ["config", "--global", `url.file://${sourceRepo}.insteadOf`, "https://github.com/vibes-test/rolling"]);
	latest = versions[1];
	// Pi installs production dependencies from the lock snapshot even with newer latest tags.
	const savedEnv = { ...process.env };
	Object.assign(process.env, env);
	const settingsManager = SettingsManager.create(home, env.PI_CODING_AGENT_DIR);
	const manager = new DefaultPackageManager({ cwd: home, agentDir: env.PI_CODING_AGENT_DIR, settingsManager });
	await manager.installAndPersist(source);
	const installed = manager.getInstalledPath(source, "user");
	const versionOf = (name) => JSON.parse(fs.readFileSync(path.join(installed, "node_modules", name, "package.json"))).version;
	for (const name of [...owned, "pinned-fixture", "transitive-fixture"]) assert.equal(versionOf(name), versions[0], `locked installer: ${name}`);
	const settingsBefore = fs.readFileSync(path.join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8");
	const packageBefore = fs.readFileSync(path.join(installed, "package.json"), "utf8");
	const lockBefore = fs.readFileSync(path.join(installed, "package-lock.json"), "utf8");
	await manager.update(source);
	for (const name of owned) assert.equal(versionOf(name), versions[0], "Pi alone does not refresh an unchanged Git checkout");
	// Execute the nightly continuation that the prior script hands over to, keeping its real npm
	// refresh. Other machine-wide operations are stubbed; nothing touches the user's setup.
	const previous = path.join(scratch, "previous");
	fs.mkdirSync(previous);
	await run("bash", ["-c", `
		source "$1/scripts/vibes"
		VIBES=$2 STATUS_FILE=$3/status.json NOTES_FILE=$3/notes LOG_FILE=$3/log PI_1_MARKER=$3/pi-1-verified.json
		printf '{"version":"1.0.0"}\n' >"$PI_1_MARKER"
		VIBES_UPDATE_LOCKED=1 VIBES_UPDATE_CONTINUED=1 VIBES_UPDATE_PREVIOUS=$4 VIBES_UPDATE_RESULTS=$'packages\\tok\\t'
		for f in load_nvm sync_settings install_pinned_pi install_hotfix_job install_refresh_job update_repo cmd_check osascript; do eval "$f() { :; }"; done
		mkdir -p "$VIBES/scripts"
		printf '#!/bin/bash\\nexit 0\\n' >"$VIBES/scripts/inventory"
		chmod +x "$VIBES/scripts/inventory"
		cp "$VIBES/scripts/inventory" "$VIBES/scripts/usage-telemetry"
		cp "$1/scripts/refresh" "$VIBES/scripts/refresh"
		cmd_update
	`, "_", root, installed, scratch, previous]);
	for (const name of owned) assert.equal(versionOf(name), versions[1], `nightly latest refresh: ${name}`);
	for (const name of ["pinned-fixture", "transitive-fixture"]) assert.equal(versionOf(name), versions[0], `unrelated locked dependency: ${name}`);
	assert.equal(fs.readFileSync(path.join(installed, "package.json"), "utf8"), packageBefore);
	assert.equal(fs.readFileSync(path.join(installed, "package-lock.json"), "utf8"), lockBefore);
	assert.equal(fs.readFileSync(path.join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"), settingsBefore, "no separate Pi entries or settings edits");
	assert.ok(JSON.parse(fs.readFileSync(path.join(scratch, "status.json"))).steps.some((step) => step.name === "rolling-packages" && step.ok));
	// Run the actual maintainer bump against the same registry: latest policy survives --save-exact.
	const bumpRepo = path.join(scratch, "bump");
	fs.mkdirSync(path.join(bumpRepo, "scripts"), { recursive: true });
	fs.copyFileSync(path.join(root, "scripts", "bump"), path.join(bumpRepo, "scripts", "bump"));
	fs.writeFileSync(path.join(bumpRepo, "package.json"), JSON.stringify(manifest));
	fs.copyFileSync(path.join(sourceRepo, ".npmrc"), path.join(bumpRepo, ".npmrc"));
	await run("bash", ["scripts/bump"], bumpRepo);
	const bumped = JSON.parse(fs.readFileSync(path.join(bumpRepo, "package.json")));
	const bumpedLock = JSON.parse(fs.readFileSync(path.join(bumpRepo, "package-lock.json")));
	assert.ok(Number.isFinite(Date.parse(bumped.piDependencyCutoff)), "bump records the tested Pi dependency cutoff");
	assert.ok(Date.parse(bumped.piDependencyCutoff) <= Date.now());
	for (const name of owned) {
		assert.equal(bumped.dependencies[name], "latest");
		assert.equal(bumpedLock.packages[""].dependencies[name], "latest");
		assert.equal(bumpedLock.packages[`node_modules/${name}`].version, versions[1]);
	}
	assert.equal(bumped.dependencies["pinned-fixture"], versions[1], "ordinary bump still pins releases");
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	console.log("ok: real Pi install/update, unchanged source, nightly rolling refresh, locked unrelated dependencies, unchanged settings/manifests, bump policy");
} finally {
	await new Promise((resolve) => registry.close(resolve));
	fs.rmSync(scratch, { recursive: true, force: true });
}
