import { feature } from "../lib/feature.ts";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const TOOL_NAME = "papercut";
const AUTO_SUBMIT_REPO: string | undefined = undefined;
const registeredApis = new WeakSet<ExtensionAPI>();
const CAPTURE_GUIDANCE = `## Pi papercut capture
When you directly encounter a small, real tool, UI, or workflow friction, record it once with the papercut tool. Supply one or two sanitized sentences, short task/repo context, and the affected surface. Never include secrets, private/customer content, raw messages, transcripts, or unnecessary output; if sanitization is uncertain, skip it. Papercuts are not blockers or tracked work. The tool attaches operational session metadata without reading session content, stores locally, and does not submit to an inbox automatically.`;

function resolveScriptPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const bundled = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "papercut");
  const candidates = [
    process.env.PAPERCUT_BIN,
    bundled,
    join(agentDir, "bin", "papercut"),
    join(homedir(), ".local", "bin", "papercut"),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? bundled;
}

const SCRIPT_PATH = resolveScriptPath();

const PARAMETERS = Type.Object({
  note: Type.String({
    description: "One or two sanitized sentences describing a small, directly observed workflow friction.",
    maxLength: 600,
  }),
  context: Type.Optional(
    Type.String({
      description: "Short sanitized task/repository context. Omit to derive it from the current working directory.",
      maxLength: 240,
    }),
  ),
  surface: Type.Optional(
    Type.String({
      description: "Tool, command, UI, or workflow surface involved, such as gh pr merge or /resume.",
      maxLength: 240,
    }),
  ),
});

type Parameters = Static<typeof PARAMETERS>;

type CaptureResult = {
  status: string;
  displayTarget: string;
  submissionUrl?: string | null;
  submissionError?: string | null;
  metadata?: Record<string, unknown>;
};

async function piVersion(pi: ExtensionAPI, signal?: AbortSignal): Promise<string | undefined> {
  const result = await pi.exec("pi", ["--version"], { signal, timeout: 5_000 });
  const version = result.stdout.trim();
  return result.code === 0 && version ? version : undefined;
}

export default feature(import.meta.url, (pi: ExtensionAPI) => {
  if (registeredApis.has(pi)) return;
  registeredApis.add(pi);

  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.papercut = CAPTURE_GUIDANCE;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Papercut",
    description:
      "Record a small, real workflow friction with sanitized text and automatically attach operational metadata from the active Pi session. Notes and metadata stay local; this tool does not submit to a remote inbox.",
    promptSnippet:
      "Record small, directly observed workflow friction with active Pi session metadata; never include secrets or customer/private content.",
    promptGuidelines: [
      "Use papercut only for a small, directly observed tool, UI, or workflow friction that does not merit interrupting the current task.",
      "Do not use papercut for blockers, requested work, tracked bugs, accomplishments, status updates, or speculative ideas.",
      "Never include secrets, credentials, tokens, private/customer content, raw messages, or unnecessary command output in papercut fields; sanitize or skip.",
      "Do not duplicate an observation already recorded in the current task.",
    ],
    parameters: PARAMETERS,
    renderResult(result, _options, theme, context) {
      const summary = result.content.find((item) => item.type === "text")?.text ?? "";
      const note = context.args.note;
      const text = note
        ? `${theme.fg("toolOutput", note)}\n${theme.fg("dim", summary)}`
        : theme.fg("dim", summary);
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params: Parameters, signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const usage = ctx.getContextUsage();
      const entries = ctx.sessionManager.getEntries();
      const branch = ctx.sessionManager.getBranch();
      const sessionStat = sessionFile ? await stat(sessionFile).catch(() => undefined) : undefined;
      const version = await piVersion(pi, signal).catch(() => undefined);
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";

      const metadata = {
        thinkingLevel: pi.getThinkingLevel(),
        sessionFile,
        sessionId: ctx.sessionManager.getSessionId(),
        contextTokens: usage?.tokens ?? null,
        contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? null,
        contextPercent: usage?.percent ?? null,
        sessionBytes: sessionStat?.size ?? null,
        sessionEntries: entries.length,
        branchEntries: branch.length,
        piVersion: version,
        surface: params.surface,
      };

      const args = [SCRIPT_PATH, "add", "--json", "--model", model, "--metadata-json", JSON.stringify(metadata)];
      if (params.context) args.push("--context", params.context);
      if (AUTO_SUBMIT_REPO) args.push("--submit-repo", AUTO_SUBMIT_REPO);
      args.push("--", params.note);

      const result = await pi.exec("python3", args, { signal, timeout: 40_000 });
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "papercut capture failed");
      }

      let capture: CaptureResult;
      try {
        capture = JSON.parse(result.stdout) as CaptureResult;
      } catch {
        throw new Error(`papercut returned invalid JSON: ${result.stdout.trim()}`);
      }

      const summary = capture.submissionUrl
        ? `Recorded locally and submitted to ${capture.submissionUrl}`
        : capture.submissionError
          ? `Recorded locally at ${capture.displayTarget}; central submission is pending (${capture.submissionError})`
          : `Recorded locally at ${capture.displayTarget}`;

      return {
        content: [{ type: "text", text: summary }],
        details: {
          target: capture.displayTarget,
          submissionUrl: capture.submissionUrl ?? undefined,
          submissionPending: Boolean(capture.submissionError),
          sessionFile,
          sessionId: metadata.sessionId,
          model,
          thinkingLevel: metadata.thinkingLevel,
          contextTokens: metadata.contextTokens,
          contextWindow: metadata.contextWindow,
          contextPercent: metadata.contextPercent,
          sessionBytes: metadata.sessionBytes,
          sessionEntries: metadata.sessionEntries,
          branchEntries: metadata.branchEntries,
          piVersion: metadata.piVersion,
        },
      };
    },
  });

  pi.registerCommand("papercuts-submit", {
    description: "Retry pending local papercuts when a default private inbox is configured",
    handler: async (_args, ctx) => {
      if (!AUTO_SUBMIT_REPO) {
        ctx.ui.notify("No default papercut inbox is configured", "warning");
        return;
      }
      const result = await pi.exec(
        "python3",
        [SCRIPT_PATH, "submit", "--all", "--repo", AUTO_SUBMIT_REPO, "--cwd", ctx.cwd],
        { timeout: 60_000 },
      );
      const message = (result.stdout || result.stderr).trim() || "No submission output";
      ctx.ui.notify(message, result.code === 0 ? "info" : "warning");
    },
  });
});
