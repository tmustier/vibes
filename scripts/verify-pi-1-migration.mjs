#!/usr/bin/env node
// The migration agent's run counts only if it really called tools, its background child wrote the
// proof file, and every MCP server connected before the upgrade still connects.
import { readFileSync, writeFileSync } from "node:fs";

const [beforeFile, afterFile, eventsFile, markerFile, childProofFile] = process.argv.slice(2);
const connected = (file) => JSON.parse(readFileSync(file, "utf8")).servers.filter((server) => server.state === "connected").map((server) => server.name);
const before = connected(beforeFile);
const after = new Set(connected(afterFile));
const lost = before.filter((name) => !after.has(name));
const tools = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .filter((event) => event.type === "tool_execution_start").map((event) => event.toolName);
let childProof;
try { childProof = readFileSync(childProofFile, "utf8"); } catch {}

const problems = [];
if (lost.length) problems.push(`previously connected MCP servers lost: ${lost.join(", ")}`);
if (!tools.includes("bash") && !tools.includes("exec_command")) problems.push("agent did not call a shell tool");
if (!tools.includes("subagent") || childProof !== "PI1_CHILD_OK") problems.push("background child proof missing");
if (problems.length) {
  console.error(`Pi 1.0 migration not verified: ${problems.join("; ")}`);
  process.exit(1);
}
writeFileSync(markerFile, JSON.stringify({ version: "1.0.0", verifiedAt: new Date().toISOString(), previouslyConnected: before }, null, 2) + "\n");
console.log(`Pi 1.0 migration verified: ${tools.length} agent tool calls, ${before.length} previously connected MCP servers retained`);
