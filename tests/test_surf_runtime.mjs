// Public updater/check/setup commands in disposable homes; real upstream host installer,
// fake npm transport. No user's Chrome, global package or native manifest is touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = path.join(repo, "node_modules/surf-cli");
const { BROWSERS } = createRequire(import.meta.url)(path.join(upstream, "native/doctor.cjs"));
const pin = JSON.parse(fs.readFileSync(path.join(repo, "package.json"))).dependencies["surf-cli"];
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vibes-surf-")));
const home = path.join(scratch, "home with spaces");
const agent = path.join(home, ".pi/agent");
const bin = path.join(scratch, "bin");
const prefix = path.join(home, ".local");
const installed = path.join(prefix, "lib/node_modules/surf-cli");
const wrapper = path.join(home, process.platform === "darwin" ? "Library/Application Support/surf-cli/host-wrapper.sh" : ".local/share/surf-cli/host-wrapper.sh");
const manifest = (browser) => path.join(home, BROWSERS[browser][process.platform], "surf.browser.host.json");
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const id = "abcdefghijklmnopabcdefghijklmnop";
const otherId = "ponmlkjihgfedcbaponmlkjihgfedcba";
// Keep every value distinct: npm's active prefix is NOT the Surf installation prefix.
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PATH: `${bin}:${prefix}/bin:/usr/bin:/bin`,
	SURF_TEST_UPSTREAM: upstream, SURF_TEST_CALLS: path.join(scratch, "npm-calls"), SURF_TEST_PIN: pin };
for (const key of Object.keys(env)) if (key.startsWith("SURF_") && !key.startsWith("SURF_TEST_")) delete env[key];
const command = (mode, args = [], status = 0, extra = {}) => {
	const result = spawnSync(process.execPath, [path.join(repo, "scripts/surf-runtime.mjs"), mode, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
	assert.equal(result.status, status, result.stdout + result.stderr);
	return result.stdout + result.stderr;
};
try {
	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(agent, { recursive: true });
	fs.symlinkSync(process.execPath, path.join(bin, "node"));
	write(path.join(bin, "npm"), `#!${process.execPath}
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0,3), ['install','-g','--prefix']);
assert.equal(args[4], 'surf-cli@' + process.env.SURF_TEST_PIN);
fs.appendFileSync(process.env.SURF_TEST_CALLS, JSON.stringify(args) + '\\n');
if (process.env.SURF_TEST_FAIL) process.exit(7);
const root = path.join(args[3], 'lib/node_modules/surf-cli');
for (const dir of ['native','dist', '../../..' + '/bin']) fs.mkdirSync(path.join(root,dir), {recursive:true});
fs.writeFileSync(path.join(root,'package.json'), JSON.stringify({name:'surf-cli', version:process.env.SURF_TEST_PIN}));
fs.writeFileSync(path.join(root,'dist/manifest.json'), JSON.stringify({version:process.env.SURF_TEST_PIN}));
fs.writeFileSync(path.join(root,'native/host.cjs'), '// fixture host');
fs.writeFileSync(path.join(root,'native/cli.cjs'), '#!/usr/bin/env node\\n');
fs.chmodSync(path.join(root,'native/cli.cjs'), 0o755);
if (!fs.existsSync(path.join(root,'scripts'))) fs.symlinkSync(path.join(process.env.SURF_TEST_UPSTREAM,'scripts'), path.join(root,'scripts'));
const bin = path.join(args[3], 'bin/surf');
if (!fs.existsSync(bin)) fs.symlinkSync(path.join(root,'native/cli.cjs'), bin);
`);
	fs.chmodSync(path.join(bin, "npm"), 0o755);
	assert.match(command("check"), /not installed.*browser tool/);
	assert.match(command("update"), /not installed/);
	assert(!fs.existsSync(env.SURF_TEST_CALLS), "updates must not install an absent runtime");
	assert.match(command("setup"), /browser setup is incomplete/);
	assert.equal(json(path.join(installed, "package.json")).version, pin);
	command("setup", [id]);
	assert.deepEqual(json(manifest("chrome")).allowed_origins, [`chrome-extension://${id}/`]);
	assert.match(fs.readFileSync(wrapper, "utf8"), new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	command("check");
	// Reproduce the real July global install + old Homebrew Node, preserving both IDs and metadata.
	write(path.join(installed, "package.json"), JSON.stringify({ name: "surf-cli", version: "2.9.0" }));
	write(path.join(installed, "dist/manifest.json"), JSON.stringify({ version: "2.9.0" }));
	const oldWrapper = `#!/usr/bin/env bash\ncd "${installed}/native"\nexec "/old/homebrew/node" "${installed}/native/host.cjs" "$@"\n`;
	write(wrapper, oldWrapper);
	const before = { ...json(manifest("chrome")), description: "Keep my description", allowed_origins: [`chrome-extension://${id}/`, `chrome-extension://${otherId}/`] };
	write(manifest("chrome"), JSON.stringify(before));
	write(manifest("brave"), JSON.stringify(before));
	assert.match(command("check", [], 1), /2\.9\.0.*Vibes=/);
	assert.equal(fs.readFileSync(wrapper, "utf8"), oldWrapper, "check is read-only");
	assert.match(command("update"), /reloaded at chrome:\/\/extensions/);
	const calls = fs.readFileSync(env.SURF_TEST_CALLS, "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(calls.at(-1), ["install", "-g", "--prefix", prefix, `surf-cli@${pin}`]);
	assert.deepEqual(json(manifest("chrome")), before);
	assert.deepEqual(json(manifest("brave")), before);
	assert.equal(json(path.join(installed, "dist/manifest.json")).version, pin);
	assert(fs.readdirSync(path.dirname(wrapper)).some((name) => name.includes(".vibes-backup-")));
	command("check");
	const current = fs.readFileSync(wrapper, "utf8");
	const notes = fs.readFileSync(path.join(agent, "vibes-update-notes"), "utf8");
	command("update");
	assert.equal(fs.readFileSync(env.SURF_TEST_CALLS, "utf8").trim().split("\n").length, calls.length, "aligned runtime does not reinstall");
	assert.equal(fs.readFileSync(path.join(agent, "vibes-update-notes"), "utf8"), notes, "aligned runtime does not renotify");
	assert.equal(fs.readFileSync(wrapper, "utf8"), current);
	// Node-only drift repairs registration without reinstalling npm.
	write(wrapper, oldWrapper);
	assert.match(command("check", [], 1), /registration differs/);
	command("update");
	assert.equal(fs.readFileSync(wrapper, "utf8"), current);
	assert.equal(fs.readFileSync(env.SURF_TEST_CALLS, "utf8").trim().split("\n").length, calls.length);
	// Custom deployments must be left intact, including listener settings in a stock wrapper.
	write(wrapper, oldWrapper.replace("exec ", "export SURF_LISTEN=100.64.1.2:4321\nexec "));
	const custom = fs.readFileSync(wrapper, "utf8");
	assert.match(command("update", [], 1), /Custom or damaged Surf wrapper/);
	assert.equal(fs.readFileSync(wrapper, "utf8"), custom);
	write(path.join(agent, "vibes.json"), '{"features":{"surf":false}}');
	assert.match(command("update"), /disabled/);
	fs.rmSync(path.join(agent, "vibes.json"));
	write(wrapper, current);
	assert.match(command("update", [], 1, { SURF_HOST_PATH: "/custom/host.cjs" }), /Custom SURF_HOST_PATH/);
	// An extension-only mismatch and npm failure remain failures, not a false successful upgrade.
	write(path.join(installed, "dist/manifest.json"), '{"version":"2.9.0"}');
	assert.match(command("check", [], 1), /extension files=2.9.0/);
	command("update", [], 1, { SURF_TEST_FAIL: "1" });
	assert.equal(json(path.join(installed, "dist/manifest.json")).version, "2.9.0");
	command("update");
	command("check");
	// A native host can point into a previous Node prefix not on PATH. Upgrade its dist too,
	// then bind the host to the active CLI; do not leave Chrome's old unpacked path stale.
	const oldPrefix = path.join(home, "old-node");
	const oldRoot = path.join(oldPrefix, "lib/node_modules/surf-cli");
	fs.cpSync(installed, oldRoot, { recursive: true, verbatimSymlinks: true });
	write(path.join(oldRoot, "package.json"), '{"name":"surf-cli","version":"2.9.0"}');
	write(path.join(oldRoot, "dist/manifest.json"), '{"version":"2.9.0"}');
	write(wrapper, `#!/usr/bin/env bash\ncd "${oldRoot}/native"\nexec "/old/node" "${oldRoot}/native/host.cjs" "$@"\n`);
	assert.match(command("check", [], 1), /2\.9\.0/);
	command("update");
	assert.equal(json(path.join(oldRoot, "dist/manifest.json")).version, pin);
	assert.equal(fs.readFileSync(wrapper, "utf8"), current);
	assert.deepEqual(JSON.parse(fs.readFileSync(env.SURF_TEST_CALLS, "utf8").trim().split("\n").at(-1)),
		["install", "-g", "--prefix", oldPrefix, `surf-cli@${pin}`]);
	command("check");
	// cmd_check must still report Pi startup, but not turn a Surf mismatch into success.
	const check = spawnSync("bash", ["-c", `source "$1/scripts/vibes"
check_surf() { echo 'Surf mismatch'; return 1; }
check_gog_keyring() { :; }
sleep() { :; }
tmux() { case "$*" in *new-session*) touch "$scratch/ready";; *capture-pane*) echo 'Pi ready';; esac; }
cmd_check ""
`, "_", repo], { env, encoding: "utf8" });
	assert.equal(check.status, 1, check.stdout + check.stderr);
	assert.match(check.stdout, /Surf mismatch/);
	assert.match(check.stdout, /Pi started cleanly/);
	console.log("ok: absent runtime, fresh setup, 2.9.0 mismatch/upgrade in original prefix, real host registration, preserved IDs, idempotence, Node drift, opt-out, custom refusal, failure propagation");
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
