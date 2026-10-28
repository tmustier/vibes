// Needs the dev dependencies (`npm install`): the step-aside uses the pinned Pi's package manager.
// Run with `npx jiti tests/test_bundled.mjs`: bundled extensions are TypeScript, which Pi loads with jiti.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { bundled } from "../lib/bundled.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const load = async (name) => (await import(pathToFileURL(path.join(root, "extensions", `${name}.ts`)))).default;
const extendingPi = await load("extending-pi"); // pi-extensions: skills only
// Surf retains two skills after pi-extensions retired its nested skill-creator. Exercise
// partial skill overlap without running Surf's unrelated extension in this unit fixture.
const surfSkills = bundled(new URL("../extensions/surf.ts", import.meta.url).href, { package: "surf-cli", skills: ["skills/surf/SKILL.md", "skills/deep-x-research/SKILL.md"], noExtensions: true });
const tmux = await load("tmux"); // mitsupi: the tmux skill only
const whimsical = await load("whimsical"); // mitsupi: one extension entry
assert.equal(fs.existsSync(path.join(root, "extensions", "notify.ts")), false, "completion popup is not bundled");
const goal = await load("goal");
const codeActions = await load("code-actions");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vibes-bundled-"));
const agentDir = path.join(scratch, "agent");
let project;
let testNumber = 0;
let current;
let mode = "tui";
const finishes = [];
const endTurn = async () => { for (const finish of finishes.splice(0)) await finish(); };
process.env.PI_CODING_AGENT_DIR = agentDir;
// Pi's interactive mode, in a terminal; `headless` below switches to pi -p.
process.stdin.isTTY = process.stdout.isTTY = true;
const headless = async (run) => {
	process.stdin.isTTY = process.stdout.isTTY = false;
	try {
		return await run();
	} finally {
		process.stdin.isTTY = process.stdout.isTTY = true;
	}
};

// Fake an installed copy of a package, laid out like the real ones, for Pi's resolver to find.
const install = (dir, name = "pi-extensions") => {
	for (const file of ["extending-pi/SKILL.md", "extending-pi/skill-creator/SKILL.md", "skills/tmux/SKILL.md"]) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), `---\nname: ${path.basename(path.dirname(file))}\ndescription: test\n---\n`);
	}
	fs.mkdirSync(path.join(dir, "extensions"), { recursive: true });
	for (const file of ["whimsical.ts", "notify.ts"]) fs.writeFileSync(path.join(dir, "extensions", file), "export default () => {};\n");
	const skills = ["./extending-pi/SKILL.md", "./extending-pi/skill-creator/SKILL.md", "./skills"];
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.1.67", pi: { extensions: ["./extensions"], skills } }));
};
const gitInstall = (repo = "tmustier/pi-extensions", name) => () => install(path.join(agentDir, "git", "github.com", repo), name);
const projectInstall = () => install(path.join(project, ".pi", "npm", "node_modules", "pi-extensions"));
const surfSource = "git:github.com/nicobailon/surf-cli";
const surfInstall = () => {
	const dir = path.join(agentDir, "git", "github.com", "nicobailon", "surf-cli");
	for (const name of ["surf", "deep-x-research"]) {
		const skill = path.join(dir, "skills", name, "SKILL.md");
		fs.mkdirSync(path.dirname(skill), { recursive: true });
		fs.writeFileSync(skill, `---\nname: ${name}\ndescription: test\n---\n`);
	}
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "surf-cli", pi: { skills: ["skills"] } }));
};

// Loads a wrapper as Pi's pre-trust pass does, with these settings (after `setup` fakes any
// installs), and returns what it registered.
const start = async (wrapper, { global = [], local, settings = {} } = {}, setup = () => {}) => {
	if (current) await sessionStart(current, true, false);
	await endTurn();
	fs.rmSync(scratch, { recursive: true, force: true });
	project = path.join(scratch, `project-${++testNumber}`);
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(project, { recursive: true });
	setup();
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ ...settings, packages: global }));
	if (local) {
		fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: local }));
	}
	process.chdir(project);
	return reload(wrapper);
};
// Loads the wrapper again in the same process, as /reload does. Pi loads extensions for `cwd`,
// which a resumed session can make differ from process.cwd(); pi.exec runs there.
const reload = async (wrapper, cwd = process.cwd()) => {
	// `other` counts what the bundled extension itself registers.
	const registered = { discover: [], sessionStart: [], messages: [], other: 0, cwd };
	const other = () => registered.other++;
	await wrapper({
		on: (event, handler) =>
			event === "resources_discover" ? registered.discover.push(handler) : event === "session_start" ? registered.sessionStart.push(handler) : event === "agent_settled" || event === "session_shutdown" ? finishes.push(handler) : other(),
		sendMessage: (message, options) => registered.messages.push({ message, options }),
		registerTool: other,
		registerCommand: other,
		registerShortcut: other,
		registerFlag: other,
		exec: async (command, args) => ({ code: 0, stdout: execFileSync(command, args, { cwd, encoding: "utf8" }), stderr: "" }),
	});
	current = registered;
	return registered;
};
// Emits resources_discover as Pi does, after it has decided trust (default: trusted).
const skills = async ({ discover, cwd }, trusted = true, notices) => {
	const ctx = { mode: notices ? mode : "print", isProjectTrusted: () => trusted, hasUI: notices !== undefined, ui: { notify: (message) => notices.push(message), theme: { fg: (color, text) => `<${color}>${text}</${color}>` } } };
	const paths = [];
	for (const handler of discover) paths.push(...((await handler({ type: "resources_discover", cwd, reason: "startup" }, ctx))?.skillPaths ?? []));
	return paths;
};
// Runs the session_start handlers with Pi's final trust decision and returns any notices (on
// stderr when there is no UI).
const sessionStart = async (registration, trusted, hasUI = true) => {
	const { sessionStart } = registration;
	const notices = [];
	const error = console.error;
	console.error = (message) => notices.push(`stderr: ${message}`);
	try {
		for (const handler of sessionStart) await handler({}, { mode: hasUI ? mode : "print", hasUI, isProjectTrusted: () => trusted, ui: { notify: (message) => notices.push(message), theme: { fg: (color, text) => `<${color}>${text}</${color}>` } } });
		await skills(registration, trusted, hasUI ? notices : undefined);
	} finally {
		console.error = error;
	}
	await endTurn();
	return notices;
};
const withArgs = async (args, run) => {
	process.argv.push(...args);
	try {
		return await run();
	} finally {
		process.argv.splice(-args.length);
	}
};

// No personal copy: the bundled skills load and exist.
const own = await skills(await start(extendingPi));
assert.equal(own.length, 1);
for (const skill of own) assert.ok(fs.existsSync(skill), skill);

// Every way of installing the same package makes the bundled copy step aside.
for (const [name, settings, setup] of [
	["git", { global: ["git:github.com/tmustier/pi-extensions"] }, gitInstall()],
	["git ref with a slash", { global: ["git:github.com/tmustier/pi-extensions@release/test"] }, gitInstall()],
	["SSH", { global: ["git:git@github.com:tmustier/pi-extensions"] }, gitInstall()],
	["ssh:// URL", { global: ["ssh://git@github.com/tmustier/pi-extensions"] }, gitInstall()],
	["npm with a version", { global: ["npm:pi-extensions@0.1.67"] }, () => install(path.join(agentDir, "npm", "node_modules", "pi-extensions"))],
	["local path", { global: [path.join(scratch, "checkout")] }, () => install(path.join(scratch, "checkout"))],
]) {
	assert.deepEqual(await skills(await start(extendingPi, settings, setup)), [], name);
}

// Pinet incorrectly declares the pi-extensions name but loads only Slack. Name alone must
// not suppress a bundled module or its skills, and must not produce a duplicate warning.
const pinet = "git:github.com/gugu91/pinet";
const pinetInstall = () => {
	const dir = path.join(agentDir, "git", "github.com", "gugu91", "pinet");
	fs.mkdirSync(path.join(dir, "slack-bridge", "dist"), { recursive: true });
	fs.writeFileSync(path.join(dir, "slack-bridge", "dist", "index.js"), "export default () => {};\n");
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-extensions", pi: { extensions: ["slack-bridge/dist/index.js"] } }));
};
const pinetOnly = { global: [{ source: pinet, extensions: ["slack-bridge/dist/index.js"], skills: [], prompts: [] }] };
const withPinet = await start(codeActions, pinetOnly, pinetInstall);
assert.ok(withPinet.other > 0, "same-name unrelated Pinet leaves /code bundled");
const pinetSkills = await reload(extendingPi);
assert.equal((await skills(pinetSkills)).length, 1, "Pinet leaves bundled skills");
assert.deepEqual(await sessionStart(withPinet, true), [], "unrelated same-name package isn't a duplicate");
const codeCopyInstall = () => {
	gitInstall()();
	const dir = path.join(agentDir, "git", "github.com", "tmustier", "pi-extensions");
	fs.mkdirSync(path.join(dir, "code-actions"));
	fs.writeFileSync(path.join(dir, "code-actions", "index.ts"), "export default () => {};\n");
	const manifestPath = path.join(dir, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath));
	manifest.pi.extensions.push("code-actions/index.ts");
	fs.writeFileSync(manifestPath, JSON.stringify(manifest));
};
const codeCopy = { source: "git:github.com/tmustier/pi-extensions", extensions: ["code-actions/index.ts"], skills: [] };
assert.equal((await start(codeActions, { global: [codeCopy] }, codeCopyInstall)).other, 0, "real personal module takes over");
assert.ok((await start(codeActions, { global: [{ ...codeCopy, extensions: ["!code-actions/index.ts"] }] }, codeCopyInstall)).other > 0, "excluded personal module leaves Vibes in place");

// A copy that loads only some of the bundled skills: the rest still load from the bundle.
assert.equal((await skills(await start(surfSkills))).length, 2, "Surf supplies a real two-skill bundle");
const partial = await start(surfSkills, { global: [{ source: surfSource, skills: ["skills/surf/SKILL.md"] }] }, surfInstall);
assert.deepEqual((await skills(partial)).map((file) => path.relative(path.join(root, "node_modules", "surf-cli"), file)), [path.join("skills", "deep-x-research", "SKILL.md")]);

// Resuming a session from another folder loads extensions for the session's folder, not the
// process's: the bundled copy steps aside there only for that folder's own copy.
const elsewhere = path.join(scratch, "elsewhere");
// Each load follows the previous session's start, as a resume does.
let previous = await start(extendingPi, { local: ["npm:pi-extensions"] }, projectInstall);
fs.mkdirSync(elsewhere, { recursive: true });
const resume = async (from, loadFor) => {
	await sessionStart(previous, true);
	process.chdir(from);
	previous = await withArgs(["--approve"], () => reload(extendingPi, loadFor));
	return (await skills(previous)).length;
};
assert.equal(await resume(elsewhere, project), 0, "session in the project, resumed from elsewhere");
assert.equal(await resume(project, elsewhere), 1, "session elsewhere, resumed from the project");
assert.equal(await resume(elsewhere, project), 0, "and back");
// The same for a bundled extension, which is decided while Pi loads.
previous = await start(whimsical, { local: ["npm:mitsupi"] }, () => install(path.join(project, ".pi", "npm", "node_modules", "mitsupi"), "mitsupi"));
fs.mkdirSync(elsewhere, { recursive: true });
const resumeExtension = async (from, loadFor) => {
	await sessionStart(previous, true);
	process.chdir(from);
	previous = await withArgs(["--approve"], () => reload(whimsical, loadFor));
	return previous.other;
};
assert.equal(await resumeExtension(elsewhere, project), 0, "extension: session in the project, resumed from elsewhere");
assert.ok((await resumeExtension(project, elsewhere)) > 0, "extension: session elsewhere, resumed from the project");
assert.equal(await resumeExtension(elsewhere, project), 0, "extension: and back");

// A copy whose filter leaves out a kind of resource doesn't cover that kind: the old Vibes
// template installs agent-stuff (mitsupi) for some extensions with "skills": [].
const agentStuff = (filter) => ({ global: [{ source: "git:github.com/mitsuhiko/agent-stuff", ...filter }] });
const agentStuffInstall = gitInstall("mitsuhiko/agent-stuff", "mitsupi");
assert.equal((await skills(await start(tmux, agentStuff({ skills: [], extensions: ["extensions/notify.ts"] }), agentStuffInstall))).length, 1, "skills filtered out");
assert.equal((await skills(await start(tmux, agentStuff({}), agentStuffInstall))).length, 0, "skills loaded");
// Pi distinguishes a plain source from an object entry: a partial manifest suppresses
// conventional directories for the plain source, but the object entry includes them.
for (const [entry, expectedSkills] of [
	["git:github.com/mitsuhiko/agent-stuff", 1],
	[{ source: "git:github.com/mitsuhiko/agent-stuff" }, 0],
]) {
	const registered = await start(tmux, { global: [entry] }, () => {
		agentStuffInstall();
		const manifestPath = path.join(agentDir, "git", "github.com", "mitsuhiko", "agent-stuff", "package.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		delete manifest.pi.skills;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
	});
	assert.equal((await skills(registered)).length, expectedSkills, "respect Pi's plain-source semantics");
}

// A plain local source can be one extension without a pi manifest or conventional directories.
const localGoal = path.join(scratch, "local-goal");
const fallback = await start(goal, { global: [localGoal] }, () => {
	fs.mkdirSync(localGoal, { recursive: true });
	fs.writeFileSync(path.join(localGoal, "package.json"), JSON.stringify({ name: "pi-codex-goal" }));
	fs.writeFileSync(path.join(localGoal, "index.ts"), "export default () => {};\n");
});
assert.equal(fallback.other, 0, "local directory fallback covers the bundle");

// A single-entry bundle only steps aside for a copy that loads that entry.
assert.ok((await start(whimsical, agentStuff({ extensions: ["extensions/notify.ts"] }), agentStuffInstall)).other > 0, "other entry");
assert.equal((await start(whimsical, agentStuff({}), agentStuffInstall)).other, 0, "same entry");

// A personal copy that gains the entry in an update: after the next session start, /reload sees it.
const agentStuffPlain = { global: ["git:github.com/mitsuhiko/agent-stuff"] };
const mitsupiDir = path.join(agentDir, "git", "github.com", "mitsuhiko", "agent-stuff");
const withoutWhimsical = await start(whimsical, agentStuffPlain, () => {
	agentStuffInstall();
	fs.rmSync(path.join(mitsupiDir, "extensions", "whimsical.ts"));
});
assert.ok(withoutWhimsical.other > 0, "copy without the entry");
await sessionStart(withoutWhimsical, true);
fs.writeFileSync(path.join(mitsupiDir, "extensions", "whimsical.ts"), "export default () => {};\n");
assert.equal((await reload(whimsical)).other, 0, "copy updated to include the entry, then /reload");

// A trusted project copy makes the bundled copy step aside, even before Pi installs it
// (Pi installs missing project packages after it decides trust, after this runs).
const projectCopy = { local: ["npm:pi-extensions"] };
for (const [name, settings, setup] of [
	["installed", projectCopy, projectInstall],
	["npm, not installed yet", projectCopy, () => {}],
	["git, not installed yet", { local: ["git:github.com/tmustier/pi-extensions"] }, () => {}],
	["git SSH, not installed yet", { local: ["git:git@github.com:tmustier/pi-extensions@v1"] }, () => {}],
]) {
	assert.deepEqual(await skills(await withArgs(["--approve"], () => start(extendingPi, settings, setup))), [], `--approve, ${name}`);
}
// ...unless its filter loads none of that kind, or excludes the bundled entry.
assert.equal((await skills(await withArgs(["--approve"], () => start(extendingPi, { local: [{ source: "npm:pi-extensions", skills: [] }] })))).length, 1);
const missingMitsupi = (filter) => withArgs(["--approve"], () => start(whimsical, { local: [{ source: "npm:mitsupi", ...filter }] }));
assert.ok((await missingMitsupi({ extensions: ["!extensions/whimsical.ts"] })).other > 0, "not installed, entry excluded");
assert.equal((await missingMitsupi({ extensions: ["extensions/whimsical.ts"] })).other, 0, "not installed, entry included");

// With --no-approve Pi won't load the project copy, so the bundled copy stays.
assert.equal((await skills(await withArgs(["--no-approve"], () => start(extendingPi, projectCopy, projectInstall)), false)).length, 1, "--no-approve");

// Extensions load before Pi decides trust, and otherwise trust isn't certain then: another
// extension's project_trust handler can overrule a saved answer or defaultProjectTrust. So a
// bundled extension steps aside for a project copy whatever they say; if Pi then doesn't trust the
// folder, a notice says so, and /reload (same process) loads the bundled copy.
const projectMitsupi = { local: ["npm:mitsupi"] };
const mitsupiInstall = () => install(path.join(project, ".pi", "npm", "node_modules", "mitsupi"), "mitsupi");
const trustFile = (decision, installIt = mitsupiInstall) => () => {
	installIt();
	fs.writeFileSync(path.join(agentDir, "trust.json"), JSON.stringify({ [fs.realpathSync(project)]: decision }));
};
for (const [name, settings, setup] of [
	["not asked yet", projectMitsupi, mitsupiInstall],
	["not installed yet", projectMitsupi, () => {}],
	["saved: do not trust", projectMitsupi, trustFile(false)],
	["saved: trust", projectMitsupi, trustFile(true)],
	["defaultProjectTrust: never", { ...projectMitsupi, settings: { defaultProjectTrust: "never" } }, mitsupiInstall],
]) {
	const first = await start(whimsical, settings, setup);
	assert.equal(first.other, 0, name);
	const notices = await sessionStart(first, false);
	assert.equal(notices.length, 1, name);
	assert.match(notices[0], /Run \/reload/);
	assert.ok((await reload(whimsical)).other > 0, `${name}: after /reload`);
}
// Trusted in the end: the ordinary personal-copy notice, and /reload keeps that copy.
const trustedInTheEnd = await start(whimsical, projectMitsupi, mitsupiInstall);
assert.match((await sessionStart(trustedInTheEnd, true))[0], /Pi is using your own copies of 1 bundled package.*\n<dim>- mitsupi<\/dim>/);
assert.equal((await reload(whimsical)).other, 0);
// Untrusted in the end, but the global copy still covers it: the ordinary notice.
const globalToo = await start(whimsical, { ...projectMitsupi, global: ["git:github.com/mitsuhiko/agent-stuff"] }, () => {
	mitsupiInstall();
	agentStuffInstall();
});
assert.match((await sessionStart(globalToo, false))[0], /Pi is using your own copies of 1 bundled package.*\n<dim>- mitsupi<\/dim>/);

// Without a terminal (pi -p, RPC) there's no /reload, so a bundled extension follows Pi's own
// order: the saved answer, defaultProjectTrust, then untrusted.
for (const [name, settings, setup, stepsAside] of [
	["headless, not asked", projectMitsupi, mitsupiInstall, false],
	["headless, saved: do not trust", projectMitsupi, trustFile(false), false],
	["headless, saved: trust", projectMitsupi, trustFile(true), true],
	["headless, defaultProjectTrust: always", { ...projectMitsupi, settings: { defaultProjectTrust: "always" } }, mitsupiInstall, true],
]) {
	assert.equal((await headless(() => start(whimsical, settings, setup))).other === 0, stepsAside, name);
}
// If an extension then keeps the folder untrusted, the loss is reported on stderr.
const overruled = await headless(() => start(whimsical, projectMitsupi, trustFile(true)));
assert.match((await sessionStart(overruled, false, false))[0], /^stderr: .*--no-approve/);

// Skills and prompts are discovered after Pi decides, so they follow its final answer, whatever
// it predicted: the reviewer's case is a saved "trust" that an extension overrules.
for (const run of [(f) => f(), headless]) {
	for (const trusted of [false, true]) {
		const discovered = await run(() => start(extendingPi, projectCopy, trustFile(true, projectInstall)));
		assert.equal((await skills(discovered, trusted)).length, trusted ? 0 : 1, "follow the final trust decision");
	}
}

// Editing settings between reloads is seen.
await sessionStart(await start(extendingPi), true);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["git:github.com/tmustier/pi-extensions"] }));
gitInstall()();
assert.deepEqual(await skills(await reload(extendingPi)), [], "settings edited, then /reload");

// The duplicate summary and one migration turn per load pass persist until resolved, even if
// several reloads step aside. Hidden startup checks, print and RPC sessions start no turn.
const firstNotice = await start(whimsical, agentStuffPlain, agentStuffInstall);
const secondNotice = await reload(whimsical);
const notices = [...await sessionStart(firstNotice, true), ...await sessionStart(secondNotice, true)];
assert.equal(notices.length, 1);
assert.match(notices[0], /Migrating duplicates to Vibes/);
assert.equal(firstNotice.messages.length, 1);
assert.match(firstNotice.messages[0].message.content, /mitsupi/);
assert.equal(secondNotice.messages.length, 0, "one migration turn per load pass");
assert.equal((await sessionStart(await reload(whimsical), true)).length, 1, "still unresolved next session");
process.env.VIBES_CHECK_READY = path.join(scratch, "ready");
try {
	const hidden = await start(whimsical, agentStuffPlain, agentStuffInstall);
	assert.deepEqual(await sessionStart(hidden, true), []);
	assert.deepEqual(hidden.messages, [], "hidden checks never start migration");
} finally {
	delete process.env.VIBES_CHECK_READY;
}
const printMode = await start(whimsical, agentStuffPlain, agentStuffInstall);
assert.deepEqual(await sessionStart(printMode, true, false), []);
assert.deepEqual(printMode.messages, [], "print sessions never start migration");
mode = "rpc";
try {
	const rpc = await start(whimsical, agentStuffPlain, agentStuffInstall);
	await sessionStart(rpc, true);
	assert.deepEqual(rpc.messages, [], "RPC has dialogs but must not start unsolicited migration turns");
} finally {
	mode = "tui";
}

// Several packages and repeated loads of one package produce one summary, with distinct
// sorted names in the UI theme's dim color. Settings changes and /reload recompute it.
const aggregate = await start(whimsical, { global: ["git:github.com/mitsuhiko/agent-stuff", "git:github.com/tmustier/pi-extensions"] }, () => {
	agentStuffInstall(); gitInstall()();
});
await reload(whimsical);
await reload(extendingPi);
const aggregateNotices = await sessionStart(aggregate, true);
assert.equal(aggregateNotices.length, 1);
assert.match(aggregateNotices[0], /^Pi is using your own copies of 2 bundled packages/);
assert.match(aggregateNotices[0], /\n<dim>- mitsupi\n- pi-extensions<\/dim>$/);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["git:github.com/tmustier/pi-extensions"] }));
const changed = await reload(whimsical);
await reload(extendingPi);
const changedNotices = await sessionStart(changed, true);
assert.equal(changedNotices.length, 1);
assert.match(changedNotices[0], /copies of 1 bundled package.*\n<dim>- pi-extensions<\/dim>$/);
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
assert.deepEqual(await sessionStart(await reload(extendingPi), true), [], "resolved copies disappear on reload");

// Skill-only wrappers notify during resource discovery, including when only one skill is
// covered. The remaining bundled skills still load. No personal copy means no notice.
for (const [filter, expectedSkills] of [
	[undefined, 0],
	[{ skills: ["skills/surf/SKILL.md"] }, 1],
]) {
	const notices = [];
	const registration = await start(surfSkills, { global: [{ source: surfSource, ...filter }] }, surfInstall);
	const files = await skills(registration, true, notices);
	assert.equal(files.length, expectedSkills);
	if (filter) assert.ok(files[0].endsWith("deep-x-research/SKILL.md"));
	assert.equal(notices.length, 1);
	assert.match(notices[0], /Pi is using your own copies of 1 bundled package.*\n<dim>- surf-cli<\/dim>/);
}
const noCopyNotices = [];
assert.equal((await skills(await start(extendingPi), true, noCopyNotices)).length, 1);
assert.deepEqual(noCopyNotices, []);

// Pi's scope precedence and autoload:false deltas must still decide which files load.
const bothScopes = { global: ["npm:mitsupi"], local: [{ source: "npm:mitsupi", extensions: [] }] };
const globalMitsupi = () => install(path.join(agentDir, "npm", "node_modules", "mitsupi"), "mitsupi");
assert.ok((await start(whimsical, bothScopes, () => { globalMitsupi(); mitsupiInstall(); })).other > 0, "project replaces global filters");
assert.ok((await start(whimsical, { global: ["npm:mitsupi"], local: [{ source: "npm:mitsupi", autoload: false, extensions: ["!extensions/whimsical.ts"] }] }, globalMitsupi)).other > 0, "delta excludes global entry without a project install");
assert.equal((await start(whimsical, { global: ["npm:mitsupi"], local: [{ source: "npm:mitsupi", autoload: false, extensions: ["!extensions/notify.ts"] }] }, globalMitsupi)).other, 0, "delta keeps other global entry");

// A missing project package can be installed between factories and resources_discover. The
// actual installed skills must win over the earlier prediction from Vibes' bundled version.
const predicted = await start(whimsical, projectMitsupi);
const predictedSkills = await reload(tmux);
mitsupiInstall();
fs.rmSync(path.join(project, ".pi", "npm", "node_modules", "mitsupi", "skills", "tmux"), { recursive: true });
await sessionStart(predicted, true);
assert.equal((await skills(predictedSkills)).length, 1, "discover sees the newly installed package, not the prediction");

// The packaged shortcut must be discovered outside the Vibes checkout, not just in its .pi dir.
const outside = fs.mkdtempSync(path.join(scratch, "outside-"));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
const settingsManager = SettingsManager.create(outside, agentDir);
const resources = await new DefaultPackageManager({ cwd: outside, agentDir, settingsManager }).resolve(async () => "skip");
// YSK must see requests after the other bundled hooks. Check Pi's resolved load order.
const extensions = resources.extensions.filter(({ enabled }) => enabled).map(({ path: file }) => path.basename(file));
assert.equal(extensions.at(-1), "you-should-know.ts", "YSK must load after the bundled request rewriters");
const shortcuts = resources.extensions.filter(({ path: file, enabled }) => enabled && file.endsWith("/continue-shortcut.ts"));
assert.equal(shortcuts.length, 1, "one packaged continue shortcut outside the checkout");
const handlers = new Map();
const messages = [];
const shortcut = (await import(pathToFileURL(shortcuts[0].path))).default;
await shortcut({ registerShortcut: (key, options) => handlers.set(key, options.handler), sendUserMessage: (text) => messages.push(text) });
await handlers.get("ctrl+shift+enter")({});
assert.deepEqual(messages, ["continue"]);

process.chdir(os.tmpdir());
fs.rmSync(scratch, { recursive: true, force: true });
console.log("ok");
