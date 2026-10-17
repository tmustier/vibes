import { feature } from "../lib/feature.ts";
/**
 * Older Vibes templates listed which Vibes files to load, so a setup built from one keeps
 * loading only those files and misses everything Vibes has added since. Every one of those
 * lists includes this file, so this is where such a setup hears about it, and where it gets the
 * per-send email approval (send-approval.ts) that no old list names. With the current template
 * (the plain Vibes source, plus any `!` exclusions) it does nothing, apart from the next point.
 *
 * Templates before July 2026 also copied Vibes' prompts into ~/.pi/agent/prompts. Pi keeps the
 * first prompt of each name and reads that folder before packages, so the copied onboard.md hides
 * the current /onboard, and running it sets Pi up the old way. A copy that is a past version of
 * Vibes' own file goes to the Trash while extensions load, before Pi reads the prompts; a copy the
 * user edited stays, with a notice.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sendApproval from "./send-approval.ts";

const VIBES = /github\.com[:/]tmustier\/vibes(?:\.git)?(?:@.*)?$/i;
const VIBES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Whether the Vibes entry in these settings lists what to load, as older templates did. */
export function usesOldVibesList(settings: { packages?: unknown[] }): boolean {
	return (settings.packages ?? []).some((pkg) => {
		if (typeof pkg !== "object" || pkg === null || !VIBES.test(String((pkg as { source?: unknown }).source))) return false;
		return ["extensions", "skills", "prompts", "themes"].some((kind) => {
			const patterns = (pkg as Record<string, unknown>)[kind];
			return Array.isArray(patterns) && patterns.some((pattern) => !/^[!+-]/.test(String(pattern)));
		});
	});
}

/** Whether content was ever prompts/onboard.md in the Vibes checkout at root (false if root has no git history). */
function isPastOnboard(root: string, content: Buffer): boolean {
	const blob = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
	try {
		return execFileSync("git", ["-C", root, "log", "-1", "--format=%H", `--find-object=${blob}`, "HEAD", "--", "prompts/onboard.md"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() !== "";
	} catch {
		return false;
	}
}

/** Moves an old copy of Vibes' onboard.md out of agentDir's prompts into trash. Returns what the user should hear, if anything. */
export function clearOldOnboard(agentDir: string, vibesRoot: string, trash: string): string | undefined {
	const copy = join(agentDir, "prompts", "onboard.md");
	if (!existsSync(copy)) return undefined;
	if (!isPastOnboard(vibesRoot, readFileSync(copy))) {
		return `Your own copy of /onboard in ${copy} hides the current one, so /onboard would set Pi up the old way. Move that file to the Trash, then run /reload and /onboard.`;
	}
	let moved = join(trash, "onboard.vibes-old.md");
	for (let n = 2; existsSync(moved); n++) moved = join(trash, `onboard.vibes-old-${n}.md`);
	renameSync(copy, moved);
	return `Moved an old copy of /onboard from ${copy} to the Trash, so /onboard now runs the current one.`;
}

function agentDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (!dir) return join(homedir(), ".pi", "agent");
	return dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

export default feature(import.meta.url, (pi: ExtensionAPI) => {
	const notices: string[] = [];
	const onboard = clearOldOnboard(agentDir(), VIBES_ROOT, join(homedir(), ".Trash"));
	if (onboard) notices.push(onboard);
	const path = join(agentDir(), "settings.json");
	if (existsSync(path) && usesOldVibesList(JSON.parse(readFileSync(path, "utf8")))) {
		sendApproval(pi);
		notices.push(
			"Your Vibes setup is out of date: your settings list the Vibes features from an older template, so you're missing the current ones. Run /onboard to update it. It keeps the packages and settings you added yourself.",
		);
	}
	if (!notices.length) return;
	pi.on("session_start", (_event, ctx) => {
		for (const notice of notices) ctx.ui.notify(notice, "warning");
	});
});
