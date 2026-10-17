import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Instructions shared by the startup duplicate migration and failed-update repair. */
export function migrationRequest(): string {
	const guide = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "existing-setups.md");
	return [
		`Migrate duplicate resources to Vibes following ${guide}. This is authorised: do not ask which copy to keep merely because their contents differ.`,
		"Vibes must own the active resource. Back up settings and keep local edits recoverable, but do not leave the duplicate loaded. Keep unrelated resources, explicit opt-outs and forks the user has explicitly chosen to maintain; an installed or differing copy alone is not that choice. For a mixed package, exclude only the duplicate resource in the personal package. Record a maintained fork by disabling its Vibes feature, not by editing Vibes files.",
		"Afterwards run `vibes check` and confirm in `vibes inventory` that the resource loads from Vibes and the duplicate does not. Report what changed and where the backups are; name any behaviour difference you could not reconcile.",
	].join("\n");
}

/**
 * Starts a repair turn unless another Pi session is already repairing this user's setup. The lock
 * is held until this session's turn settles; a lock whose holder is no longer running is stale.
 */
export function requestRepair(pi: ExtensionAPI, customType: string, content: string): boolean {
	const lock = join(getAgentDir(), "vibes-repair.lock");
	for (;;) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		try {
			process.kill(Number(readFileSync(lock, "utf8")), 0);
			return false;
		} catch {
			rmSync(lock, { force: true });
		}
	}
	let held = true;
	const release = () => {
		if (held) rmSync(lock, { force: true });
		held = false;
	};
	pi.on("agent_settled", release);
	pi.on("session_shutdown", release);
	pi.sendMessage({ customType, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	return true;
}
