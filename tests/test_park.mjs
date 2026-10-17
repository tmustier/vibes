import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import park, { decodeParkRecord, encodeParkRecord, relaunchArgs } from "../extensions/park.ts";

const WRAPPER = new URL("../scripts/pi-park", import.meta.url).pathname;

test("relaunchArgs keeps runtime flags and drops session selection and prompts", () => {
	const argv = relaunchArgs(
		[
			"--continue",
			"--name",
			"old-name",
			"--model",
			"anthropic/claude-x:high",
			"--extension",
			"./a.ts",
			"-e",
			"./b.ts",
			"--tools",
			"read,bash",
			"--append-system-prompt",
			"line1\nline2",
			"--recap-idle-seconds",
			"30",
			"--recap-disable",
			"--approve",
			"@notes.md",
			"initial prompt text",
		],
		"/sessions/s.jsonl",
		{ provider: "openai-codex", id: "gpt-6-sol" },
		"medium",
	);
	assert.deepEqual(argv, [
		"--model",
		"openai-codex/gpt-6-sol",
		"--thinking",
		"medium",
		"--append-system-prompt",
		"line1\nline2",
		"--tools",
		"read,bash",
		"--extension",
		"./a.ts",
		"--extension",
		"./b.ts",
		"--approve",
		"--recap-idle-seconds",
		"30",
		"--recap-disable",
		"--session",
		"/sessions/s.jsonl",
	]);
});

test("relaunchArgs pins the parked model instead of the original --model flag", () => {
	const argv = relaunchArgs(["--model", "sonnet"], "/s.jsonl", { provider: "anthropic", id: "claude-opus" }, "high");
	assert.deepEqual(argv, ["--model", "anthropic/claude-opus", "--thinking", "high", "--session", "/s.jsonl"]);
	assert.deepEqual(relaunchArgs([], "/s.jsonl", undefined, undefined), ["--session", "/s.jsonl"]);
});

test("park record survives a NUL-separated round trip", () => {
	const record = { cwd: "/w", title: "deal x", sessionFile: "/s.jsonl", argv: ["--session", "/s.jsonl"] };
	const encoded = encodeParkRecord(record);
	assert.equal(encoded.endsWith("\0"), false);
	assert.deepEqual(decodeParkRecord(encoded), record);
});

function fakePi(env) {
	const events = new Map();
	const flags = new Map();
	return {
		events,
		flags,
		activeTools: [],
		sessionName: undefined,
		on(name, handler) {
			events.set(name, handler);
		},
		registerCommand(name, options) {
			this.command = options.handler;
		},
		registerFlag(name, options) {
			flags.set(name, options.default);
		},
		getFlag(name) {
			return flags.get(name);
		},
		getActiveTools() {
			return this.activeTools;
		},
		getSessionName() {
			return this.sessionName;
		},
		setSessionName(name) {
			this.sessionName = name;
		},
		getThinkingLevel() {
			return "medium";
		},
	};
}

function fakeCtx(overrides = {}) {
	const notices = [];
	return {
		notices,
		mode: "tui",
		cwd: "/work",
		model: { provider: "p", id: "m" },
		shutdowns: 0,
		editorText: "",
		confirmAnswer: true,
		sessionManager: { getSessionFile: () => "/sessions/s.jsonl" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		shutdown() {
			this.shutdowns += 1;
		},
		ui: {
			notify: (message, type) => notices.push({ message, type }),
			confirm: async () => overrides.confirmAnswer ?? true,
			getEditorText() {
				return overrides.editorText ?? "";
			},
			setEditorText(text) {
				overrides.restored = text;
			},
			onTerminalInput: () => () => {},
		},
		...overrides,
	};
}

function withWrapperEnv(fn) {
	const dir = mkdtempSync(join(tmpdir(), "park-test-"));
	const parkFile = join(dir, "park");
	const saved = { ...process.env };
	process.env.PI_PARK_FILE = parkFile;
	process.env.PI_PARK_WRAPPER_PID = String(process.ppid);
	try {
		return fn(parkFile);
	} finally {
		process.env = saved;
	}
}

test("/park explains the launcher requirement when started directly or inside another Pi", async () => {
	delete process.env.PI_PARK_FILE;
	const pi = fakePi();
	park(pi);
	const ctx = fakeCtx();
	await pi.command("", ctx);
	assert.equal(ctx.shutdowns, 0);
	assert.match(ctx.notices[0].message, /started without its launcher/);
	assert.ok(ctx.notices[0].message.includes(WRAPPER));

	await withWrapperEnv(async (parkFile) => {
		process.env.PI_PARK_WRAPPER_PID = String(process.pid);
		const nested = fakePi();
		park(nested);
		const ctx = fakeCtx();
		await nested.command("", ctx);
		assert.equal(ctx.shutdowns, 0);
		assert.match(ctx.notices[0].message, /started without its launcher/);
		assert.equal(existsSync(parkFile), false, "a nested Pi must not write its parent's park record");
	});
});

test("/park refuses a session that is not persisted", async () => {
	await withWrapperEnv(async () => {
		const wrappedPi = fakePi();
		park(wrappedPi);
		const ephemeral = fakeCtx({ sessionManager: { getSessionFile: () => undefined } });
		await wrappedPi.command("", ephemeral);
		assert.equal(ephemeral.shutdowns, 0);
		assert.match(ephemeral.notices[0].message, /not persisted/);
	});
});

test("/park writes the record, names the session, and shuts down", async () => {
	await withWrapperEnv(async (parkFile) => {
		const pi = fakePi();
		park(pi);
		const ctx = fakeCtx({ editorText: "half-typed" });
		await pi.command("deal follow-up", ctx);
		assert.equal(ctx.shutdowns, 1);
		assert.equal(pi.sessionName, "deal follow-up");
		const record = decodeParkRecord(readFileSync(parkFile, "utf8"));
		assert.equal(record.cwd, "/work");
		assert.equal(record.title, "deal follow-up");
		assert.equal(record.sessionFile, "/sessions/s.jsonl");
		assert.deepEqual(record.argv.slice(-2), ["--session", "/sessions/s.jsonl"]);
		assert.equal(readFileSync(`${parkFile}.draft`, "utf8"), "half-typed");

		const restored = {};
		pi.events.get("session_start")({ reason: "startup" }, fakeCtx(restored));
		assert.equal(restored.restored, "half-typed");
		assert.equal(existsSync(`${parkFile}.draft`), false);
		pi.events.get("session_shutdown")({}, fakeCtx());
	});
});

test("/park asks before parking a Slack or Pinet connected session", async () => {
	await withWrapperEnv(async () => {
		const pi = fakePi();
		park(pi);
		pi.activeTools = ["read", "pinet"];
		const declined = fakeCtx({ confirmAnswer: false });
		await pi.command("", declined);
		assert.equal(declined.shutdowns, 0);
		const accepted = fakeCtx({ confirmAnswer: true });
		await pi.command("", accepted);
		assert.equal(accepted.shutdowns, 1);
	});
});

test("/park waits for the agent and gives up when messages are queued", async () => {
	await withWrapperEnv(async () => {
		const pi = fakePi();
		park(pi);
		let idle = false;
		const ctx = fakeCtx({
			isIdle: () => idle,
			waitForIdle: async () => {
				idle = true;
			},
			hasPendingMessages: () => true,
		});
		await pi.command("", ctx);
		assert.equal(ctx.shutdowns, 0);
		assert.match(ctx.notices.at(-1).message, /Queued messages/);
	});
});

test("auto-park defaults to 60 idle minutes and fires only when user, agent, and UI are all idle", async () => {
	await withWrapperEnv(async () => {
		const pi = fakePi();
		park(pi);
		assert.equal(pi.flags.get("park-after"), "60");
		const ctx = fakeCtx();
		const intervals = [];
		const realSetInterval = globalThis.setInterval;
		globalThis.setInterval = (fn, ms) => {
			intervals.push({ fn, ms });
			return 1;
		};
		const realClearInterval = globalThis.clearInterval;
		globalThis.clearInterval = () => {};
		const realNow = Date.now;
		let now = 1_000_000;
		Date.now = () => now;
		try {
			pi.events.get("session_start")({ reason: "startup" }, ctx);
			assert.equal(intervals.length, 1);
			const tick = intervals[0].fn;

			tick();
			assert.equal(ctx.shutdowns, 0, "not idle long enough");
			now += 61 * 60_000;
			pi.events.get("agent_start")({}, ctx);
			tick();
			assert.equal(ctx.shutdowns, 0, "agent running");
			pi.events.get("agent_settled")({}, ctx);
			tick();
			assert.equal(ctx.shutdowns, 0, "settlement counts as activity");
			now += 61 * 60_000;
			pi.events.get("ui_prompt_start")({}, ctx);
			tick();
			assert.equal(ctx.shutdowns, 0, "dialog open");
			pi.events.get("ui_prompt_end")({}, ctx);
			now += 61 * 60_000;
			pi.activeTools = ["slack"];
			tick();
			assert.equal(ctx.shutdowns, 0, "connected sessions never auto-park");
			pi.activeTools = [];
			await pi.command("off", ctx);
			tick();
			assert.equal(ctx.shutdowns, 0, "/park off disables auto-park");
			await pi.command("on", ctx);
			tick();
			assert.equal(ctx.shutdowns, 1);
			tick();
			assert.equal(ctx.shutdowns, 1, "parks once");
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
			Date.now = realNow;
		}
	});
});

test("wrapper keeps the terminal, relaunches on the parked session, and passes exit codes through", async () => {
	const dir = mkdtempSync(join(tmpdir(), "park-wrapper-"));
	const fakeDir = join(dir, "fake");
	const wrapDir = join(dir, "wrap");
	const workDir = join(dir, "work");
	for (const d of [fakeDir, wrapDir, workDir]) mkdirSync(d);
	symlinkSync(WRAPPER, join(wrapDir, "pi"));
	const log = join(dir, "log");
	const fake = join(fakeDir, "pi");
	writeFileSync(
		fake,
		`#!/bin/zsh
print -r -- "ppid=$PPID wrapper=$PI_PARK_WRAPPER_PID cwd=$PWD args=\${(j:|:)@}" >> "${log}"
if [[ ! -e "${log}.parked" ]]; then
	touch "${log}.parked"
	printf '%s' "${workDir}"$'\\0'"title"$'\\0'"/s.jsonl"$'\\0'"--model"$'\\0'"p/m"$'\\0'"--session"$'\\0'"/s.jsonl" > "$PI_PARK_FILE"
	print -r -- "$PI_PARK_FILE" > "${log}.parkfile"
	exit 0
fi
exit 7
`,
	);
	chmodSync(fake, 0o755);

	const child = spawn(join(wrapDir, "pi"), ["--foo", "bar"], {
		cwd: dir,
		env: { ...process.env, PATH: `${wrapDir}:${fakeDir}:${process.env.PATH}`, TERM: "xterm" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	const parkFile = await new Promise((resolve) => {
		const poll = setInterval(() => {
			if (!existsSync(`${log}.parkfile`)) return;
			clearInterval(poll);
			resolve(readFileSync(`${log}.parkfile`, "utf8").trim());
		}, 50);
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.match(stdout, /⏸ parked/);
	writeFileSync(`${parkFile}.wake`, "");
	const code = await new Promise((resolve) => child.on("exit", resolve));
	assert.equal(code, 7);
	const runs = readFileSync(log, "utf8").trim().split("\n");
	assert.equal(runs.length, 2);
	assert.match(runs[0], /args=--foo\|bar$/);
	assert.match(runs[1], new RegExp(`cwd=${workDir} args=--model\\|p/m\\|--session\\|/s.jsonl$`));
	const wrapperPid = runs[0].match(/wrapper=(\d+)/)[1];
	assert.equal(runs[1].match(/ppid=(\d+)/)[1], wrapperPid);
	assert.equal(existsSync(parkFile), false);
	assert.equal(existsSync(`${parkFile}.wake`), false);
});
