import { feature } from "../lib/feature.ts";
/**
 * Non-Interactive Bash — prevents editors and pagers from hanging pi.
 *
 * Pi already closes stdin (stdio: ["ignore", "pipe", "pipe"]), so programs
 * reading from stdin get EOF immediately. But some programs (git, brew)
 * spawn editor/pager subprocesses that read from /dev/tty, bypassing stdin.
 * These env vars prevent that.
 *
 * GIT_EDITOR/GIT_SEQUENCE_EDITOR use "true" (exit 0 = accept content as-is).
 * EDITOR/VISUAL use "false" (exit 1 = fail loudly so the LLM knows to retry).
 *
 * Set the Pi process environment rather than replacing its bash tool. Every
 * subprocess inherits these safeguards, and other global or project-local bash
 * extensions can still compose normally.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  EDITOR: "false",
  VISUAL: "false",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  HOMEBREW_NO_AUTO_UPDATE: "1",
};

export default feature(import.meta.url, (_pi: ExtensionAPI) => {
  Object.assign(process.env, NON_INTERACTIVE_ENV);
});
