// Template updates must not change between incompatible OpenAI OAuth routes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const template = JSON.parse(readFileSync("settings.template.json", "utf8"));
const forProvider = (value, provider) => {
 const result = JSON.parse(JSON.stringify(value).replaceAll("openai-codex", provider));
 if (provider === "openai") {
  result.compaction.modelOverrides["openai-codex/gpt-6.1-sol"] = result.compaction.modelOverrides["openai/gpt-6.1-sol"];
  delete result.compaction.modelOverrides["openai/gpt-6.1-sol"];
 }
 return result;
};
assert.equal(template.defaultProvider, "openai-codex");
assert.equal(template.defaultModel, "gpt-6.1-sol");
for (const id of ["gpt-6.1-sol", "gpt-6-astra"]) {
 assert.ok(template.enabledModels.includes(`openai-codex/${id}:medium`));
 assert.deepEqual(template.compaction.modelOverrides[`openai-codex/${id}`], id === "gpt-6.1-sol" ? { reserveTokens: 50000 } : undefined);
}
assert.ok(template.enabledModels.includes("anthropic/claude-fable-5-2:high"));
assert.deepEqual(template.compaction.modelOverrides["anthropic/claude-fable-5-2"], { reserveTokens: 600000 });
assert.equal(template.compaction.modelOverrides["anthropic/claude-fable-5-1"], undefined);
assert.equal(template.subagents.agentOverridesByProvider["openai-codex"].oracle.model, "anthropic/claude-fable-5-2");
assert.equal(template.subagents.agentOverridesByProvider.anthropic.oracle.model, "openai-codex/gpt-6.1-sol");
assert.match(readFileSync("prompts/onboard.md", "utf8"), /Do not require an `openai` login/);
assert.match(readFileSync("scripts/vibes", "utf8"), /local AGENT_MODEL="\$provider\/gpt-6\.1-sol:medium"/);

const root = mkdtempSync(join(tmpdir(), "vibes-openai-sync-"));
try {
 const previous = join(root, "previous"), agent = join(root, "agent");
 mkdirSync(previous); mkdirSync(agent);
 const run = (prev, current) => {
  writeFileSync(join(previous, "settings.template.json"), JSON.stringify(prev));
  writeFileSync(join(agent, "settings.json"), JSON.stringify(current));
  execFileSync(process.execPath, ["scripts/sync-settings.mjs", previous, process.cwd(), agent]);
  return JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
 };
 for (const provider of ["openai-codex", "openai"]) {
  const expected = forProvider(template, provider);
  // Exercise both directions of a template-only provider change, including old model updates.
  for (const previousProvider of ["openai", "openai-codex"]) {
   const prev = forProvider(template, previousProvider);
   prev.defaultModel = "gpt-6-sol";
   prev.enabledModels[0] = `${previousProvider}/gpt-6-sol:medium`;
   const current = structuredClone(expected);
   current.defaultModel = "gpt-6-sol";
   current.enabledModels[0] = `${provider}/gpt-6-sol:medium`;
   const personal = { theme: "dark", packages: ["npm:personal"] };
   const synced = run(prev, { ...current, ...personal });
   for (const key of ["defaultProvider", "defaultModel", "enabledModels", "subagents", "compaction"]) {
    assert.deepEqual(synced[key], expected[key], `${provider} keeps its route while updating ${key}`);
   }
   assert.equal(synced.theme, personal.theme);
   assert.deepEqual(synced.packages, personal.packages);
   assert.deepEqual(run(prev, synced), synced, "repeat sync is idempotent");
  }
  // Fable upgrades move the model list, compaction key and oracle together on either route.
  const previousFable = JSON.parse(JSON.stringify(expected).replaceAll("claude-fable-5-2", "claude-fable-5-1"));
  assert.deepEqual(run(previousFable, previousFable), expected);
  const customFable = structuredClone(previousFable);
  customFable.subagents.agentOverridesByProvider[provider].oracle.model = "anthropic/claude-opus-5-5";
  const expectedCustom = structuredClone(expected);
  expectedCustom.subagents = customFable.subagents;
  assert.deepEqual(run(previousFable, customFable), expectedCustom, "personal oracle choice survives the Fable upgrade");
  // Ordinary compaction updates still apply; deliberate overrides survive.
  const prev = structuredClone(expected);
  prev.compaction.modelOverrides[`${provider}/gpt-6.1-sol`] = { reserveTokens: 22000 };
  assert.deepEqual(run(prev, prev).compaction, expected.compaction);
  const custom = structuredClone(prev);
  custom.compaction.modelOverrides[`${provider}/gpt-6.1-sol`].reserveTokens = 30000;
  assert.deepEqual(run(prev, custom).compaction, custom.compaction);
  // Anthropic default users keep the OpenAI route used in their model list and oracle.
  const anthropic = { ...expected, defaultProvider: "anthropic", defaultModel: "claude-opus-5-5" };
  assert.deepEqual(run(template, anthropic), anthropic);
 }
 assert.equal(run({}, {}).defaultProvider, "openai-codex", "fresh Business default");
 console.log("OpenAI routes preserved, model updates and personal settings: ok");
} finally {
 rmSync(root, { recursive: true, force: true });
}
