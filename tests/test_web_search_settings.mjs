// Web activation follows the template in the config pi-web-access actually reads.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const defaults = { toolActivation: "auto", tools: { sourceCheck: { enabled: false } } };
assert.deepEqual(JSON.parse(readFileSync("web-search.template.json", "utf8")), defaults);
const root = mkdtempSync(join(tmpdir(), "vibes-web-settings-"));
const write = (path, value) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
};
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
try {
	const previous = join(root, "previous");
	const vibes = join(root, "vibes");
	const agent = join(root, "home", ".pi", "agent");
	const legacy = join(dirname(agent), "web-search.json");
	const canonical = join(agent, "web-search.json");
	const xdg = join(root, "xdg");
	const xdgPath = join(xdg, "pi", "web-search.json");
	mkdirSync(previous);
	write(join(vibes, "web-search.template.json"), defaults);
	const sync = (env = {}) => execFileSync(process.execPath, ["scripts/sync-settings.mjs", previous, vibes, agent], {
		env: { ...process.env, PI_CODING_AGENT_DIR: "", XDG_CONFIG_HOME: "", VIBES_UPDATE_LOCKED: "", ...env },
	});

	// Fresh setups defer on models with append-only support and keep the upstream eager fallback. Repeated syncs make no changes.
	sync();
	assert.deepEqual(read(canonical), defaults);
	sync();
	assert.deepEqual(read(canonical), defaults);
	rmSync(canonical);

	// Updating a legacy file must not create a new config that shadows its provider settings.
	write(legacy, { provider: "exa", fetch: { defaultMode: "raw" } });
	sync();
	assert.deepEqual(read(legacy), { provider: "exa", fetch: { defaultMode: "raw" }, ...defaults });
	assert.equal(existsSync(canonical), false);

	// Canonical config wins over legacy. Explicit user overrides remain theirs.
	write(canonical, { toolActivation: "dynamic", provider: "brave" });
	sync();
	assert.deepEqual(read(canonical), { ...defaults, toolActivation: "dynamic", provider: "brave" });
	assert.equal(read(legacy).provider, "exa");
	write(canonical, { toolActivation: "eager" });
	sync();
	assert.equal(read(canonical).toolActivation, "eager");

	// Existing followers of the eager workaround move to deferred loading.
	write(join(previous, "web-search.template.json"), { toolActivation: "eager" });
	sync();
	assert.equal(read(canonical).toolActivation, "auto");

	// Manage only sourceCheck: keep other tool overrides, alternate names and provider settings.
	write(canonical, { tools: { fetchContent: { enabled: false } }, toolNames: { webSearch: "search_web" } });
	sync();
	assert.deepEqual(read(canonical), {
		toolActivation: "auto",
		tools: { fetchContent: { enabled: false }, sourceCheck: { enabled: false } },
		toolNames: { webSearch: "search_web" },
	});
	write(canonical, { tools: { sourceCheck: { enabled: true }, fetchContent: { enabled: false } } });
	sync();
	assert.equal(read(canonical).tools.sourceCheck.enabled, true, "a deliberate source-check override stays enabled");
	assert.equal(read(canonical).tools.fetchContent.enabled, false);

	// Later defaults update followers without replacing their other tool settings.
	write(join(previous, "web-search.template.json"), defaults);
	write(join(vibes, "web-search.template.json"), { ...defaults, tools: { sourceCheck: { enabled: true } } });
	write(canonical, { tools: { sourceCheck: { enabled: false }, fetchContent: { enabled: false } } });
	sync();
	assert.equal(read(canonical).tools.sourceCheck.enabled, true);
	assert.equal(read(canonical).tools.fetchContent.enabled, false);
	write(join(vibes, "web-search.template.json"), defaults);

	// XDG takes precedence over canonical, with the extension's legacy fallback.
	write(xdgPath, { provider: "exa" });
	sync({ XDG_CONFIG_HOME: xdg });
	assert.equal(read(xdgPath).toolActivation, "auto");
	rmSync(xdgPath);
	write(legacy, { provider: "exa" });
	sync({ XDG_CONFIG_HOME: xdg });
	assert.equal(read(legacy).toolActivation, "auto");
	assert.equal(existsSync(xdgPath), false);
	rmSync(legacy);
	sync({ XDG_CONFIG_HOME: xdg });
	assert.equal(read(xdgPath).toolActivation, "auto");

	// An explicit Pi config directory wins over XDG and legacy.
	write(canonical, { provider: "brave" });
	sync({ PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: xdg });
	assert.deepEqual(read(canonical), { provider: "brave", ...defaults });
	console.log("web search settings ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
