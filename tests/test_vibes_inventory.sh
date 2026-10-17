#!/bin/bash
# vibes inventory must describe what Pi really loaded, including skills that bundled packages add
# at startup, with tools and commands credited to the package behind each Vibes wrapper.
# A filtered personal package does not hide the bundle, and two wrappers of one package can make
# different decisions. Needs tmux and `npm install --omit=dev`.
set -u
cd "$(dirname "$0")/.."
export PI_CODING_AGENT_DIR=$(mktemp -d)
trap 'rm -rf "$PI_CODING_AGENT_DIR"' EXIT
cat >"$PI_CODING_AGENT_DIR/settings.json" <<JSON
{"packages": ["$PWD",
	{"source": "$PWD/node_modules/surf-cli", "extensions": [], "skills": []},
	{"source": "$PWD/node_modules/pine-of-glass", "extensions": ["extensions/pi-traceline/index.ts"], "skills": [], "prompts": []}
]}
JSON
# Explicit collection must work even if users opt out of internal helper wrappers.
printf '%s\n' '{"features":{"inventory":false,"vibes-check":false}}' >"$PI_CODING_AGENT_DIR/vibes.json"
output=$(scripts/vibes inventory) || { echo "FAIL: vibes inventory exited non-zero:"; echo "$output"; exit 1; }
node -e '
	const assert = require("node:assert/strict");
	const inventory = JSON.parse(process.argv[1]);
	const surf = inventory.skills.find((skill) => skill.name === "surf");
	assert.ok(surf?.inContext && surf.from === "Vibes (surf-cli)", `surf skill: ${JSON.stringify(surf)}`);
	assert.equal(inventory.tools.find((tool) => tool.name === "subagent")?.from, "Vibes (pi-subagents)");
	assert.ok(inventory.tools.some((tool) => !tool.active), "no inactive tools reported");
	const sections = inventory.context.sections.map((section) => section.id);
	for (const id of ["system", "skills", "tools"]) assert.ok(sections.includes(id), `context section ${id} missing: ${sections}`);
	for (const [wrapper, steppedAside] of [["surf", false], ["contextimate", false], ["traceline", true]]) {
		const entry = inventory.extensions.find((item) => item.from === "Vibes" && item.path === `extensions/${wrapper}.ts`);
		assert.equal(entry?.bundles.steppedAside, steppedAside, wrapper);
	}
' "$output" || exit 1
echo ok
