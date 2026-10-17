import { feature } from "../lib/feature.ts";
import { migrationRequest, requestRepair } from "../lib/migration.ts";
/**
 * Warns about failed or overdue updates and requests a repair once per failure.
 * Home updates use their own log and retry command, without remote reports or AGENTS reviews.
 * Legacy managed-update records retain their notes and optional template review.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // agent-default (not a user rule): 2026-09-28

interface UpdateStatus {
	updater?: "home";
	finishedAt: string;
	log: string;
	steps: Array<{ name: string; ok: boolean }>;
	notes?: string[];
	agentsTemplateHash?: string;
}

/** The update's notes, unless Pi has already shown them (seen is the finishedAt they were shown for). */
export function unseenNotes(status: UpdateStatus | undefined, seen: string | undefined): string[] {
	if (!status?.notes?.length || status.finishedAt === seen) return [];
	return status.notes;
}

function installationFailed(status: UpdateStatus): boolean {
	return status.steps.some((step) => !step.ok && step.name !== "telemetry" && step.name !== "usage-telemetry");
}

export function updateWarning(status: UpdateStatus | undefined, now: number): string | undefined {
	if (!status) return "No Vibes update has been recorded on this Mac. Run `vibes update`; /onboard can set up optional nightly updates.";
	const finished = new Date(status.finishedAt);
	const when = finished.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
	if (now - finished.getTime() > STALE_AFTER_MS) {
		if (status.updater === "home") {
			return `The last Vibes update ran on ${when}. Run \`vibes update\` to update now; use \`vibes status\` to inspect the last result and nightly job.`;
		}
		return `The last Vibes update ran on ${when}. If this Mac was off, Vibes catches up after login. Run \`vibes refresh\` to check now, or /onboard if updates stay overdue.`;
	}
	if (installationFailed(status)) {
		const failed = status.steps.filter((step) => !step.ok).map((step) => step.name);
		return `The Vibes update on ${when} failed: ${failed.join(", ")}. Details in ${status.log}; ask Pi to fix it, then run \`vibes update\`.`;
	}
	if (status.steps.some((step) => !step.ok)) {
		return "Update succeeded; telemetry upload pending. Vibes retries hourly; run `vibes refresh` to retry now.";
	}
	return undefined;
}

const vibesDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What the agent is asked to do about a failed update. */
export function fixRequest(status: UpdateStatus, sessionFile: string | undefined): string {
	const failed = status.steps.filter((step) => !step.ok).map((step) => step.name);
	return [
		`The nightly Vibes update failed at: ${failed.join(", ")}.`,
		`Read the last run in ${status.log} (from its final "=== … ${status.updater === "home" ? "personal Vibes update" : "vibes update"}" line) and fix the cause.`,
		...(failed.includes("startup") ? [migrationRequest()] : []),
		"Then run `vibes update` and confirm it succeeds. Tell the user in plain English what failed and what you changed.",
		...(status.updater === "home" ? [] : [
			`Finally, report it to the Vibes maintainers: \`vibes report '${sessionFile ?? "none (this session is not saved)"}' '<two or three sentences: what failed, what you changed, and whether vibes update now succeeds>'\`.`,
		]),
	].join("\n");
}

const template = join(vibesDir, "AGENTS.template.md");

/** What the agent is asked to do when the team's AGENTS.md template has changed. */
export function reviewRequest(agents: string): string {
	return [
		`The team's AGENTS.md template (${template}) has changed since this user's ${agents} was last reviewed against it.`,
		`Compare the two; \`git -C ${vibesDir} log -p -- AGENTS.template.md\` shows what changed in the template.`,
		"Propose making the shared guidance match the template: add what is new, and reword or remove shared text the template has reworded or dropped. Keep the user's personal sections and their deliberate edits.",
		"Explain the proposed changes in plain English and apply them only if the user agrees, backing up the file first. If nothing needs to change, say so in one line.",
	].join("\n");
}

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

function readIfExists(file: string): string | undefined {
	try {
		return readFileSync(join(agentDir(), file), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Read the updater's kernel lock, not a PID/age guess that can outlive a shutdown. */
export function updateIsRunning(): boolean {
	return spawnSync("/usr/bin/perl", ["-MFcntl=:flock", "-e",
		'open(my $lock, "+<", $ARGV[0]) or exit 0; flock($lock, LOCK_EX | LOCK_NB) or exit 75;',
		join(agentDir(), "vibes-update.flock"),
	], { stdio: "ignore" }).status === 75;
}

export default feature(import.meta.url, (pi: ExtensionAPI) => {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const text = readIfExists("vibes-update.json");
		const status = text === undefined ? undefined : (JSON.parse(text) as UpdateStatus);
		// `vibes check` starts Pi out of sight; the fix and the notes wait for a Pi the user sees.
		const hidden = Boolean(process.env.VIBES_CHECK_READY) || ctx.mode !== "tui";
		// Login/wake may have started catch-up before Pi. Do not announce a stale failure or
		// launch a competing repair while the updater actually holds the shared lock.
		if (updateIsRunning()) return;
		const warning = updateWarning(status, Date.now());
		if (status && installationFailed(status) && !hidden && readIfExists("vibes-update-fixing")?.trim() !== status.finishedAt) {
			if (requestRepair(pi, "vibes-update-failed", fixRequest(status, ctx.sessionManager.getSessionFile()))) {
				writeFileSync(join(agentDir(), "vibes-update-fixing"), `${status.finishedAt}\n`);
			} else if (warning) {
				ctx.ui.notify(`${warning} Another Pi session is already repairing this setup.`, "warning");
			}
		} else {
			if (warning) ctx.ui.notify(warning, "warning");
			// One agent turn per start: the review waits while a failed update is being fixed.
			const templateHash = createHash("sha256").update(readFileSync(template)).digest("hex");
			if (!hidden && status && status.updater !== "home" && !installationFailed(status) && status.agentsTemplateHash === templateHash && readIfExists("AGENTS.md") !== undefined && readIfExists("vibes-agents-reviewed")?.trim() !== templateHash) {
				writeFileSync(join(agentDir(), "vibes-agents-reviewed"), `${templateHash}\n`);
				pi.sendMessage({ customType: "vibes-agents-changed", content: reviewRequest(join(agentDir(), "AGENTS.md")), display: true }, { triggerTurn: true });
			}
		}
		if (hidden) return;
		const notes = unseenNotes(status, readIfExists("vibes-update-seen")?.trim());
		if (status && notes.length) {
			ctx.ui.notify(notes.join("\n"), "info");
			writeFileSync(join(agentDir(), "vibes-update-seen"), `${status.finishedAt}\n`);
		}
	});
});
