// sync-settings.mjs: a setting follows the template unless the user changed it from the previous template.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./test_openai_provider.mjs";
import "./test_sol_context.mjs";
import "./test_web_search_settings.mjs";

const root = mkdtempSync(join(tmpdir(), "vibes-sync-"));
const write = (path, value) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
};
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

try {
	const previous = join(root, "previous");
	const vibes = join(root, "vibes");
	const agent = join(root, "agent");
	const oracle = (model) => ({ agentOverridesByProvider: { "openai-codex": { oracle: { model } } } });

	write(join(previous, "settings.template.json"), {
		enabledModels: ["openai-codex/gpt-6-sol:medium"],
		defaultModel: "gpt-6-sol",
		compaction: { enabled: true, keepRecentTokens: 20_000 },
		subagents: oracle("anthropic/claude-fable-5-1"),
	});
	write(join(vibes, "settings.template.json"), {
		enabledModels: ["openai-codex/gpt-7-sol:medium"],
		defaultModel: "gpt-7-sol",
		compaction: { enabled: true, keepRecentTokens: 30_000 },
		subagents: oracle("anthropic/claude-fable-6"),
		packages: ["git:github.com/tmustier/vibes"],
	});
	write(join(previous, "subagent-config.template.json"), { forceTopLevelAsync: true });
	write(join(vibes, "subagent-config.template.json"), { forceTopLevelAsync: true });
	write(join(agent, "settings.json"), {
		enabledModels: ["openai-codex/gpt-6-sol:medium"],
		defaultModel: "my-own-model",
		compaction: { keepRecentTokens: 20_000, enabled: true },
		packages: ["npm:personal"],
		theme: "dark",
	});

	execFileSync(process.execPath, ["scripts/sync-settings.mjs", previous, vibes, agent]);

	assert.deepEqual(read(join(agent, "settings.json")), {
		enabledModels: ["openai-codex/gpt-7-sol:medium"],
		defaultModel: "my-own-model",
		compaction: { enabled: true, keepRecentTokens: 30_000 },
		packages: ["npm:personal"],
		theme: "dark",
		subagents: oracle("anthropic/claude-fable-6"),
	});
	assert.deepEqual(read(join(agent, "extensions", "subagent", "config.json")), { forceTopLevelAsync: true });
	// Destinations are personal routing, not a preference that follows template revisions.
	write(join(previous, "settings.template.json"), { telemetryDestination: null });
	write(join(vibes, "settings.template.json"), { telemetryDestination: { type: "github", repository: "example/team" } });
	for (const settings of [{}, { telemetryDestination: null }, {
		telemetryDestination: { type: "http", url: "https://example.net/pi", identity: "home" }, vibesTelemetry: false,
	}]) {
		write(join(agent, "settings.json"), settings);
		execFileSync(process.execPath, ["scripts/sync-settings.mjs", previous, vibes, agent]);
		const updated = read(join(agent, "settings.json"));
		assert.equal(Object.hasOwn(updated, "telemetryDestination"), Object.hasOwn(settings, "telemetryDestination"));
		assert.deepEqual(updated.telemetryDestination, settings.telemetryDestination);
		assert.equal(updated.vibesTelemetry, settings.vibesTelemetry);
	}
	console.log("ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
