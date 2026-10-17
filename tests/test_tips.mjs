// Setups built from an older Vibes template are told to run /onboard, and a copied old /onboard is moved out of its way.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import tips, { clearOldOnboard, usesOldVibesList } from "../extensions/tips.ts";

const vibes = (filter, source = "git:github.com/tmustier/vibes") => ({ packages: ["npm:pi-mcp-adapter", { source, ...filter }] });

// The Vibes entry of each older template: skills only (March to July), then files of every kind.
for (const [era, settings] of [
	["2026-03", vibes({ skills: ["skills/tmux/SKILL.md"] })],
	["2026-07", vibes({ extensions: ["extensions/tips.ts"], prompts: ["prompts/onboard.md"], skills: ["skills/unslop/SKILL.md"] })],
	["2026-09", vibes({ extensions: ["extensions/papercut.ts", "extensions/tips.ts"], themes: [] })],
	["SSH source", vibes({ skills: ["skills/tmux/SKILL.md"] }, "git:git@github.com:tmustier/vibes.git")],
	["branch", vibes({ extensions: ["extensions/tips.ts"] }, "git:github.com/tmustier/vibes@nightly-updates")],
]) {
	assert.equal(usesOldVibesList(settings), true, era);
}

// The current template and its opt-outs.
for (const [form, settings] of [
	["plain source", { packages: ["git:github.com/tmustier/vibes"] }],
	["exclusions", vibes({ extensions: ["!extensions/surf.ts"], prompts: ["!prompts/papercuts-review.md"] })],
	["force include and exclude", vibes({ extensions: ["+extensions/surf.ts", "-extensions/tmux.ts"] })],
	["everything off", vibes({ skills: [] })],
	["another package's list", { packages: [{ source: "git:github.com/tmustier/vibes-extra", skills: ["a"] }, "git:github.com/tmustier/vibes"] }],
	["no packages", {}],
]) {
	assert.equal(usesOldVibesList(settings), false, form);
}
// Loaded from an old list, it also brings per-send approval (no old list names send-approval.ts)
// and the notice; with the current template it registers nothing.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibes-tips-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const load = (settings) => {
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
	const registered = [];
	tips({ on: (event) => registered.push(event), events: { on: (channel) => registered.push(channel) } });
	return registered.sort();
};
assert.deepEqual(load(vibes({ extensions: ["extensions/tips.ts"] })), ["pi-mcp-adapter:tool-approval-request", "session_start", "session_start", "tool_call"]);
assert.deepEqual(load({ packages: ["git:github.com/tmustier/vibes"] }), []);

// A copied onboard.md that is a past version of Vibes' own goes to the Trash, never over an
// earlier one; an edited copy, or one Vibes' history can't vouch for, stays.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibes-onboard-"));
const repo = path.join(scratch, "vibes");
const trash = path.join(scratch, ".Trash");
const copy = path.join(scratch, "agent", "prompts", "onboard.md");
fs.mkdirSync(path.join(repo, "prompts"), { recursive: true });
fs.mkdirSync(trash);
fs.mkdirSync(path.dirname(copy), { recursive: true });
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
git("init", "-q");
for (const version of ["onboard v1\n", "onboard v2\n"]) {
	fs.writeFileSync(path.join(repo, "prompts", "onboard.md"), version);
	fs.writeFileSync(path.join(repo, "README.md"), "readme\n");
	git("add", "-A");
	git("commit", "-qm", version);
}
const clear = (content, root = repo) => {
	fs.writeFileSync(copy, content);
	return clearOldOnboard(path.join(scratch, "agent"), root, trash);
};
assert.match(clear("onboard v1\n"), /^Moved/);
assert.match(clear("onboard v2\n"), /^Moved/);
assert.equal(fs.existsSync(copy), false);
assert.equal(fs.readFileSync(path.join(trash, "onboard.vibes-old.md"), "utf8"), "onboard v1\n");
assert.equal(fs.readFileSync(path.join(trash, "onboard.vibes-old-2.md"), "utf8"), "onboard v2\n");
for (const [kept, root] of [["onboard v1, edited\n", repo], ["readme\n", repo], ["onboard v1\n", scratch]]) {
	assert.match(clear(kept, root), /^Your own copy/, kept);
	assert.equal(fs.readFileSync(copy, "utf8"), kept);
}
fs.rmSync(copy);
assert.equal(clearOldOnboard(path.join(scratch, "agent"), repo, trash), undefined);

// At startup, with the current template, a known committed onboard.md still goes, with a notice.
// Use history rather than the working file so uncommitted prompt edits don't change the fixture.
process.env.HOME = scratch;
fs.mkdirSync(path.join(agentDir, "prompts"));
fs.writeFileSync(path.join(agentDir, "prompts", "onboard.md"), execFileSync("git", ["show", "HEAD:prompts/onboard.md"], { cwd: new URL("..", import.meta.url) }));
assert.deepEqual(load({ packages: ["git:github.com/tmustier/vibes"] }), ["session_start"]);
assert.equal(fs.existsSync(path.join(agentDir, "prompts", "onboard.md")), false);
assert.equal(fs.existsSync(path.join(trash, "onboard.vibes-old-3.md")), true);
fs.rmSync(scratch, { recursive: true });
fs.rmSync(agentDir, { recursive: true });
console.log("ok");
