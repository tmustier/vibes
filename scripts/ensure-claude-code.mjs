#!/usr/bin/env node
// Install the provider's CLI prerequisite when missing; leave existing installations alone.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { featureDefaults, readFeatureConfig } from "../lib/features.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const features = readFeatureConfig(join(agentDir, "vibes.json"));
if (!(features["claude-code"] ?? featureDefaults["claude-code"])) process.exit(0);

const command = process.env.PI_CLAUDE_CODE_COMMAND || "claude";
const found = spawnSync("bash", ["-c", 'command -v "$1"', "bash", command], { encoding: "utf8" });
if (found.status === 0) {
	console.log("Claude Code is already installed; left alone.");
	process.exit(0);
}
if (process.env.PI_CLAUDE_CODE_COMMAND) {
	console.error(`PI_CLAUDE_CODE_COMMAND is not available: ${command}`);
	process.exit(1);
}
const install = spawnSync("npm", ["install", "-g", "@anthropic-ai/claude-code"], { stdio: "inherit" });
if (install.error) console.error(install.error.message);
if (install.status !== 0) process.exit(install.status ?? 1);
console.log("Claude Code installed. Run `claude auth login`, then `/claude-code-status` in Pi.");
