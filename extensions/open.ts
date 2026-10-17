import { feature } from "../lib/feature.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * /open <path> — open a file or directory using macOS `open`.
 *
 * Features:
 *   - Tab-completes paths from cwd
 *   - Strips line breaks from pasted wrapped paths
 *   - No argument = opens the last file path from the session (read/write/edit tool calls)
 *
 * Examples:
 *   /open tpm_icp_master_list.csv
 *   /open output/report.pdf
 *   /open .                        (opens cwd in Finder)
 *   /open                          (opens last file touched in session)
 */
export default feature(import.meta.url, (pi: ExtensionAPI) => {
  /** Walk the session branch backwards and return the last path from a read/write/edit tool call. */
  function findLastPath(ctx: ExtensionCommandContext): string | undefined {
    const entries = ctx.sessionManager.getBranch();
    const toolsWithPath = new Set(["read", "write", "edit", "Read", "Write", "Edit"]);

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "message") continue;
      const msg = entry.message;

      if (msg.role === "assistant") {
        for (let j = msg.content.length - 1; j >= 0; j--) {
          const block = msg.content[j];
          if (block.type === "toolCall" && toolsWithPath.has(block.name) && typeof block.arguments.path === "string") {
            return block.arguments.path;
          }
        }
      }
    }

    return undefined;
  }

  /** Collapse line-wrapped pasted paths: strip newlines + leading whitespace on continuation lines. */
  function normalizePath(raw: string): string {
    return raw.replace(/\n\s*/g, "").trim();
  }

  /** Expand ~ and resolve relative to cwd. */
  function resolvePath(target: string, cwd: string): string {
    const expanded = target.startsWith("~") ? target.replace(/^~/, os.homedir()) : target;
    return path.resolve(cwd, expanded);
  }

  pi.registerCommand("open", {
    description: "Open a file/dir with default macOS app. No args = last path from session.",

    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      try {
        const normalized = prefix.replace(/^\.\//, "");
        const dir = path.dirname(normalized);
        const base = path.basename(normalized);
        const isTrailingSlash = prefix.endsWith("/");

        const lookIn = isTrailingSlash ? normalized : dir === "." && !normalized.includes("/") ? "." : dir;
        const filterBy = isTrailingSlash ? "" : base;

        const entries = readdirSync(lookIn, { withFileTypes: true });
        const items: AutocompleteItem[] = [];

        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          if (filterBy && !entry.name.toLowerCase().startsWith(filterBy.toLowerCase())) continue;

          const relative = lookIn === "." ? entry.name : path.join(lookIn, entry.name);
          const display = entry.isDirectory() ? `${relative}/` : relative;
          items.push({ value: display, label: display });
        }

        items.sort((a, b) => {
          const aDir = a.label!.endsWith("/") ? 0 : 1;
          const bDir = b.label!.endsWith("/") ? 0 : 1;
          return aDir - bDir || a.label!.localeCompare(b.label!);
        });

        return items.length > 0 ? items : null;
      } catch {
        return null;
      }
    },

    handler: async (args, ctx) => {
      let target = normalizePath(args);

      // No argument: find last path from session
      if (!target) {
        const lastPath = findLastPath(ctx);
        if (!lastPath) {
          ctx.ui.notify("No file path found in session history", "warning");
          return;
        }
        target = lastPath;
        ctx.ui.notify(`Opening last path: ${target}`, "info");
      }

      const resolved = resolvePath(target, ctx.cwd);

      // Check it exists
      try {
        statSync(resolved);
      } catch {
        ctx.ui.notify(`Not found: ${target}`, "error");
        return;
      }

      const result = await pi.exec("open", [resolved], { timeout: 5000 });

      if (result.code === 0) {
        ctx.ui.notify(`Opened ${target}`, "info");
      } else {
        ctx.ui.notify(`Failed to open: ${result.stderr || "unknown error"}`, "error");
      }
    },
  });
});
