// Keep the shell CLI, registered native host and unpacked extension files on Vibes' pin.
// Chrome owns the running extension/host: never restart it or claim these checks verify it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFeatureConfig } from "../lib/features.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const run = (command, args, env = process.env) => execFileSync(command, args, { env, stdio: "inherit" });
const guide = `${root}/docs/existing-setups.md#surf-commands-are-unknown-or-surf-is-missing`;

function main() {
	const [mode, extensionId] = process.argv.slice(2);
	assert(["check", "update", "setup"].includes(mode), "Expected check, update or setup [extension-id]");
	assert(!extensionId || (mode === "setup" && /^[a-p]{32}$/.test(extensionId)), "Expected the 32-letter extension ID from chrome://extensions");
	if (readFeatureConfig(path.join(agent, "vibes.json")).surf === false) {
		console.log("Surf is disabled in vibes.json; runtime left alone.");
		return;
	}
	assert(["darwin", "linux"].includes(process.platform) && !process.env.WSL_DISTRO_NAME,
		`Surf runtime maintenance supports macOS and Linux native browsers; use upstream setup on this platform. ${guide}`);
	// These select a different deployment or carry settings the stock installer would erase.
	for (const key of ["SURF_NODE_PATH", "SURF_HOST_PATH", "SURF_EXTENSION_PATH", "SURF_REMOTE", "SURF_SOCKET", "SURF_LISTEN", "SURF_SOCKET_MODE", "SURF_SOCKET_GROUP"]) {
		assert(!process.env[key], `Custom ${key} is set; review the Surf deployment manually. ${guide}`);
	}
	const pinned = json(path.join(root, "package.json")).dependencies["surf-cli"];
	assert(/^\d+\.\d+\.\d+$/.test(pinned), "surf-cli must have an exact version pin");
	const bundled = path.join(root, "node_modules/surf-cli");
	assert.equal(json(path.join(bundled, "package.json")).version, pinned, "Bundled Surf differs from the pin; reinstall Vibes dependencies first");
	const { BROWSERS, HOST_NAME } = createRequire(import.meta.url)(path.join(bundled, "native/doctor.cjs"));
	const roots = new Set();
	const packageRoot = (file, entry) => {
		const real = fs.realpathSync(file);
		const dir = path.dirname(path.dirname(real));
		assert(real === path.join(dir, "native", entry) && json(path.join(dir, "package.json")).name === "surf-cli",
			`Unrecognised Surf executable ${file}; leave custom installs alone and follow ${guide}`);
		assert(dir.endsWith("/lib/node_modules/surf-cli") && !fs.existsSync(path.join(dir, ".git")),
			`Surf at ${dir} is not a global npm install; migrate it explicitly using ${guide}`);
		roots.add(dir);
		return dir;
	};
	let active;
	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		const bin = path.resolve(dir, "surf");
		if (!fs.existsSync(bin)) continue;
		fs.accessSync(bin, fs.constants.X_OK);
		const installed = packageRoot(bin, "cli.cjs");
		active ??= installed;
	}
	const wrapper = path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support/surf-cli/host-wrapper.sh" : ".local/share/surf-cli/host-wrapper.sh");
	const manifests = [];
	for (const [browser, config] of Object.entries(BROWSERS)) {
		if (!config[process.platform]) continue;
		const file = path.join(os.homedir(), config[process.platform], `${HOST_NAME}.json`);
		if (!fs.existsSync(file)) continue;
		const manifest = json(file);
		assert(manifest.path === wrapper, `Custom Surf native host in ${file}; review manually. ${guide}`);
		assert(manifest.allowed_origins?.length && manifest.allowed_origins.every((origin) => /^chrome-extension:\/\/[a-p]{32}\/$/.test(origin)),
			`Invalid Surf allowed_origins in ${file}; follow ${guide}`);
		manifests.push({ browser, file, id: manifest.allowed_origins[0].split("/")[2] });
	}
	// Recognise only upstream's uncustomised wrapper (2.9.0 and 2.25.0 share this shape).
	// Never execute shell text to discover its host, nor discard listener/socket customisations.
	let host;
	if (fs.existsSync(wrapper)) {
		const match = read(wrapper).match(/^#!\/usr\/bin\/env bash\ncd "([^"\n]+)"\nexec "([^"\n]+)" "([^"\n]+)" "\$@"\n$/);
		assert(match && match[1] === path.dirname(match[3]), `Custom or damaged Surf wrapper ${wrapper}; review manually. ${guide}`);
		host = packageRoot(match[3], "host.cjs");
	} else {
		assert(!manifests.length || mode !== "check", `Surf host wrapper is missing; run vibes update. ${guide}`);
	}
	if (!active && mode !== "setup") {
		assert(!manifests.length && !host, `Surf is registered but missing from PATH; restore its npm bin directory, then run vibes update. ${guide}`);
		console.log(`Surf is not installed; run /onboard (vibes surf-setup), or use the browser tool for visual checks. ${guide}`);
		return;
	}
	if (!active) {
		// # agent-default (not a user rule): 2026-11-03. Stable path across nvm Node upgrades.
		active = path.join(os.homedir(), ".local/lib/node_modules/surf-cli");
		assert(!fs.existsSync(active), `Surf exists at ${active} but is not on PATH; add ~/.local/bin first`);
		roots.add(active);
	}
	// Upstream writes these paths inside double-quoted shell strings without escaping.
	assert(!/["$`\\\n\r]/.test(active + process.execPath), "Surf install paths contain shell metacharacters; register the host manually");
	const desiredWrapper = `#!/usr/bin/env bash\ncd "${active}/native"\nexec "${process.execPath}" "${active}/native/host.cjs" "$@"\n`;
	let noted = false;
	const notify = () => {
		if (noted) return;
		noted = true;
		const message = `Surf was updated to ${pinned}. Chrome keeps running the old extension until Surf is reloaded at chrome://extensions; Pi does this itself the next time a Surf command reports a stale extension.`;
		fs.mkdirSync(agent, { recursive: true });
		fs.appendFileSync(path.join(agent, "vibes-update-notes"), `${message}\n`);
		console.log(message);
	};
	for (const dir of roots) {
		const installed = fs.existsSync(path.join(dir, "package.json")) ? json(path.join(dir, "package.json")).version : "missing";
		const extension = fs.existsSync(path.join(dir, "dist/manifest.json")) ? json(path.join(dir, "dist/manifest.json")).version : "missing";
		if (installed !== pinned || extension !== pinned) {
			assert(mode !== "check", `Surf mismatch: ${dir} CLI/host=${installed}, extension files=${extension}, Vibes=${pinned}. Run vibes update.`);
			notify(); // Also survives a partial npm failure.
			run("npm", ["install", "-g", "--prefix", path.resolve(dir, "../../.."), `surf-cli@${pinned}`]);
		}
		assert.equal(json(path.join(dir, "package.json")).version, pinned, `Surf installation failed at ${dir}`);
		assert.equal(json(path.join(dir, "dist/manifest.json")).version, pinned, `Surf extension files differ at ${dir}`);
	}
	if (extensionId && !manifests.some(({ browser }) => browser === "chrome")) {
		manifests.push({ browser: "chrome", id: extensionId });
	}
	for (const manifest of manifests) {
		if (read(wrapper) === desiredWrapper && !(extensionId && manifest.browser === "chrome")) continue;
		assert(mode !== "check", `Surf host registration differs from the active CLI/Node; run vibes update. ${guide}`);
		notify();
		if (fs.existsSync(wrapper)) fs.copyFileSync(wrapper, `${wrapper}.vibes-backup-${Date.now()}`);
		if (manifest.file) fs.copyFileSync(manifest.file, `${manifest.file}.vibes-backup-${Date.now()}`);
		run(process.execPath, [path.join(active, "scripts/install-native-host.cjs"), extensionId && manifest.browser === "chrome" ? extensionId : manifest.id, "--browser", manifest.browser],
			{ ...process.env, SURF_NODE_PATH: process.execPath, SURF_HOST_PATH: path.join(active, "native/host.cjs") });
		assert.equal(read(wrapper), desiredWrapper, "Surf installer did not register the selected host and Node");
	}
	if (!manifests.length) {
		console.log(`Surf ${pinned} files are installed, but browser setup is incomplete. Load unpacked ${active}/dist at chrome://extensions, then run vibes surf-setup <extension-id>. Add ${path.resolve(active, "../../../bin")} to PATH if needed.`);
	} else {
		console.log(`Surf CLI/host/extension files match Vibes ${pinned}. Running Chrome is unverified; use surf doctor and the smoke test in ${guide}`);
	}
}

try { main(); } catch (error) { console.error(`Surf: ${error.message}`); process.exitCode = 1; }
