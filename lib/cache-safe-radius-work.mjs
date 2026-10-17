// Compatibility for the optional official npm package, not a new bundled capability.
// Covers global settings and the global npm install, not project installs or custom roots.
// Keep the upstream command, status and login code; change only its known prompt hook.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE = "@earendil-works/pi-radius-work";
export const OLD_HOOK = `  pi.on("before_agent_start", (event) => {
    const connections = listGoogleWorkspaceConnections();
    if (connections.length === 0) {
      return {
        systemPrompt:
          event.systemPrompt +
          "\\n\\nGoogle Workspace: no locally connected accounts were found. If the user asks for Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, or Meet access, ask them to run /google-workspaces first.",
      };
    }

    const lines = connections.map((connection) => \`- \${connection.email}\`);
    return {
      systemPrompt:
        event.systemPrompt +
        "\\n\\nGoogle Workspace local connections:\\n" +
        \`\${lines.join("\\n")}\\n\` +
        "When the user asks for Google Workspace data for a specific email account, use the matching connected account above. Resolve credentials privately in the runtime; do not expose token values or token file paths in responses. If they do not specify an account and exactly one account is connected, use it by default.",
    };
  });`;

export const NEW_HOOK = `  pi.on("before_agent_start", (event) => {
    const connections = listGoogleWorkspaceConnections();
    if (connections.length === 0) {
      event.systemPromptOptions.sections.google_workspaces =
        "Google Workspace: no locally connected accounts were found. If the user asks for Gmail, Calendar, Drive, Docs, Sheets, Slides, Contacts, or Meet access, ask them to run /google-workspaces first.";
      return;
    }

    const lines = connections.map((connection) => \`- \${connection.email}\`);
    event.systemPromptOptions.sections.google_workspaces =
      "Google Workspace local connections:\\n" +
      \`\${lines.join("\\n")}\\n\` +
      "When the user asks for Google Workspace data for a specific email account, use the matching connected account above. Resolve credentials privately in the runtime; do not expose token values or token file paths in responses. If they do not specify an account and exactly one account is connected, use it by default.";
  });`;

export function patchRadiusWork(agentDir) {
  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return "Radius Work is not configured; nothing to patch";
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const configured = (settings.packages ?? []).some((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return source === `npm:${PACKAGE}` || source?.startsWith(`npm:${PACKAGE}@`);
  });
  // Deliberately maintained git/local forks are not the official npm copy.
  if (!configured) return "Official npm Radius Work is not configured; nothing to patch";
  const root = join(agentDir, "npm", "node_modules", PACKAGE);
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) return "Radius Work is not installed; nothing to patch";
  if (JSON.parse(readFileSync(manifestPath, "utf8")).name !== PACKAGE) {
    throw new Error("Unexpected Radius Work package identity; left unchanged");
  }
  const path = join(root, "extensions", "radius-google-workspaces.ts");
  const source = readFileSync(path, "utf8");
  if (source.includes(NEW_HOOK)) return "Radius Work prompt hook is already cache-safe";
  if (source.split(OLD_HOOK).length !== 2) {
    // An upstream structured hook needs no patch. Unknown rewrites need inspection,
    // not a blind replacement that could overwrite the user's changes.
    if (source.includes("event.systemPromptOptions.sections.google_workspaces =") && !source.includes("systemPrompt:")) {
      return "Radius Work has an upstream cache-safe prompt hook";
    }
    throw new Error("Radius Work prompt hook changed; left unchanged. Review its before_agent_start hook before using deferred tools.");
  }
  writeFileSync(path, source.replace(OLD_HOOK, NEW_HOOK));
  return "Patched the optional Radius Work prompt hook for cache-safe tool loading";
}
