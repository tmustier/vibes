// Prints the user's settings entries for the packages Vibes installs (settings.template.json),
// in the form the user wrote them, installed or not (`pi update` installs a missing one). Pi's
// own package identity ignores the ref and the protocol, so any form of the same repo (a ref with
// a slash, SSH, ...) matches.
//
// Usage: node lib/vibes-sources.mjs <path to the pi command> <settings.template.json>
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [piCommand, template] = process.argv.slice(2);

let root = dirname(realpathSync(piCommand));
const isPi = (dir) => existsSync(join(dir, "package.json")) && JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent";
while (!isPi(root)) {
	if (dirname(root) === root) throw new Error(`no Pi package above ${piCommand}`);
	root = dirname(root);
}
const { DefaultPackageManager, getAgentDir, SettingsManager } = await import(pathToFileURL(join(root, "dist", "index.js")).href);

const agentDir = getAgentDir();
const cwd = homedir();
const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
const sourceOf = (entry) => (typeof entry === "string" ? entry : entry.source);
const identity = (source) => packages.getPackageIdentity(source, "user");
const vibes = new Set(JSON.parse(readFileSync(template, "utf8")).packages.map((entry) => identity(sourceOf(entry))));
for (const { source, scope } of packages.listConfiguredPackages()) {
	if (scope === "user" && vibes.has(identity(source))) console.log(source);
}
