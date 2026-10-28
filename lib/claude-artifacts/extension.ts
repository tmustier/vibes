import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getAgentDir, isReadToolResult, isToolCallEventType, type ExtensionAPI, type ToolAnnotations, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAMESPACE = "claude_artifacts";
const TOOLS = ["Artifact", "ArtifactComments", "ArtifactData"] as const;
// The names the tools had as MCP tools, kept so sessions that loaded them still resume.
const TOOL_PREFIX = `mcp__${NAMESPACE}__`;
const ARTIFACT_TOOL = `${TOOL_PREFIX}Artifact`;
const TOOL_SEARCH = "tool_search";
// agent-default (not a user rule): 2026-10-27. Large multi-file publishes can take minutes.
const CALL_TIMEOUT_MS = 300_000;
// agent-default (not a user rule): 2026-10-27. Keeps Claude Code running through an editing burst
// (a fresh start adds about 0.6 s to a call); a session that stops using artifacts then holds none.
const IDLE_MS = 5 * 60_000;
const here = dirname(fileURLToPath(import.meta.url));
const API_SCRIPT = join(here, "artifact-api.py");
const SKILLS = ["artifact-design", "artifact-capabilities"].map((name) => join(here, "skills", name));
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PROMPT_SECTION = `Claude Code's artifact tools (namespace \`${NAMESPACE}\`) are not declared to you. When the user asks to publish, read, update, list, share or delete a claude.ai artifact (a web page hosted on claude.ai), or about its comments or shared database, load them with \`${TOOL_SEARCH}\`.`;

type McpContent = TextContent | ImageContent | { type: "audio" | "resource" | "resource_link" };
type McpResult = { content: McpContent[]; isError?: boolean };
type ClaudeTool = { name: typeof TOOLS[number]; description: string; inputSchema: ToolDefinition["parameters"]; annotations?: ToolAnnotations };
type Method = "tools/list" | "tools/call";
type ClaudeCode = { cwd: string; running(): boolean; request<T>(method: Method, params: object, signal?: AbortSignal): Promise<T>; close(): void };

/** A `claude mcp serve` in `cwd` that answers requests until closed. */
function startClaudeCode(cwd: string, env: NodeJS.ProcessEnv): ClaudeCode {
	// Claude Code is a Bun binary. It cannot verify claude.ai when it inherits Node's
	// --use-openssl-ca option inherited from the shell (checked with Claude Code 2.1.302).
	const NODE_OPTIONS = env.NODE_OPTIONS?.split(/\s+/).filter((option) => option && option !== "--use-openssl-ca").join(" ");
	// Claude Code turns artifacts off in SDK and MCP-server sessions unless CLAUDE_CODE_ARTIFACT is set.
	const child = spawn("claude", ["mcp", "serve"], { cwd, env: { ...env, NODE_OPTIONS, CLAUDE_CODE_ARTIFACT: "1" }, stdio: ["pipe", "pipe", "ignore"] });
	const waiting = new Map<number, { done: (result: never) => void; fail: (error: Error) => void }>();
	const failAll = (error: Error) => {
		for (const request of waiting.values()) request.fail(error);
		waiting.clear();
	};
	child.on("error", failAll);
	child.on("exit", () => failAll(new Error("Claude Code exited before answering")));
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) {
			const message: { id: number } & ({ error: { message: string } } | { result: never }) = JSON.parse(buffer.slice(0, at));
			const request = waiting.get(message.id);
			waiting.delete(message.id);
			if ("error" in message) request?.fail(new Error(message.error.message));
			else request?.done(message.result);
		}
	});
	const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
	let next = 1;
	const request = <T>(method: string, params: object) =>
		new Promise<T>((done, fail) => {
			const id = next++;
			waiting.set(id, { done: done as (result: never) => void, fail });
			send({ id, method, params });
		});
	const ready = request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-claude-artifacts", version: "1" } }).then(() => send({ method: "notifications/initialized" }));
	return {
		cwd,
		running: () => child.exitCode === null && child.signalCode === null,
		async request<T>(method: Method, params: object, signal?: AbortSignal) {
			await ready;
			let timer: NodeJS.Timeout | undefined;
			const stop = new Promise<never>((_, fail) => {
				timer = setTimeout(() => fail(new Error(`Claude Code did not answer within ${CALL_TIMEOUT_MS / 1000} seconds`)), CALL_TIMEOUT_MS);
				const cancel = () => fail(new Error("Cancelled"));
				if (signal?.aborted) cancel();
				else signal?.addEventListener("abort", cancel, { once: true });
			});
			return Promise.race([request<T>(method, params), stop]).finally(() => clearTimeout(timer));
		},
		close: () => child.kill(),
	};
}

/** One request to a Claude Code started for it alone. */
async function askClaudeCode<T>(cwd: string, env: NodeJS.ProcessEnv, method: Method, params: object): Promise<T> {
	const claude = startClaudeCode(cwd, env);
	try {
		return await claude.request<T>(method, params);
	} finally {
		claude.close();
	}
}

/** Call one of Claude Code's artifact tools in a Claude Code of its own. */
export const callClaudeCode = (name: typeof TOOLS[number], args: Record<string, unknown>, cwd: string): Promise<McpResult> =>
	askClaudeCode(cwd, process.env, "tools/call", { name, arguments: args });

/** The artifact UUID in a claude.ai/artifact/{base58 id} or claude.ai/code/artifact/{uuid} link. */
function artifactId(url: unknown): string | undefined {
	if (typeof url !== "string") return undefined;
	const uuid = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
	if (uuid) return uuid.toLowerCase();
	const short = url.match(/\/artifact\/(?:[^/?#]*-)?([1-9A-HJ-NP-Za-km-z]{20,22})(?:[/?#]|$)/)?.[1];
	if (!short) return undefined;
	let value = 0n;
	for (const char of short) value = value * 58n + BigInt(BASE58.indexOf(char));
	const hex = value.toString(16).padStart(32, "0");
	if (hex.length !== 32) return undefined;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((done, fail) => {
		execFile(command, args, { timeout: 60_000, signal }, (error, stdout, stderr) => {
			if (error) fail(new Error(stderr.trim() || error.message));
			else done(stdout);
		});
	});
}

type LiveArtifact = { version: string; files: Record<string, string> };
type FileHash = { path: string; sha256: string };
type FileRead = FileHash | { path: string; error: string };
// Optional tool arguments can arrive as null from providers' strict schemas.
type ArtifactInput = {
	action?: string | null;
	url?: string | null;
	type_url?: string | null;
	file_path?: string | null;
	force?: boolean | null;
	overwrite_unread?: string[] | null;
	root?: string | null;
	files?: unknown;
};
// JSON result fields used from Claude Code's publish, list and read responses.
type ArtifactResult = {
	artifact_id?: string;
	version?: string;
	path?: string;
	url?: string;
	files_written?: FileHash[];
	file_list?: { files: FileHash[] };
	file_read?: FileHash;
	files_read?: { files: FileRead[] };
};

const resultText = (content: McpContent[]) => content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

export default function claudeArtifacts(
	pi: ExtensionAPI,
	{
		env = process.env,
		deleteArtifact = (id: string, signal?: AbortSignal) => run("python3", [API_SCRIPT, "delete", id], signal),
		liveArtifact = async (id: string, signal?: AbortSignal): Promise<LiveArtifact> => JSON.parse(await run("python3", [API_SCRIPT, "live", id], signal)),
		idleMs = IDLE_MS,
		cacheDir = join(getAgentDir(), "cache", "claude-artifacts"),
		openUrl = (url: string) => run("open", [url]),
	} = {},
) {
	// On by default: without Claude Code, add nothing.
	const claude = (env.PATH ?? "").split(delimiter).map((dir) => join(dir, "claude")).find((file) => {
		try {
			accessSync(file, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
	if (!claude) return;
	pi.on("resources_discover", async () => ({ skillPaths: SKILLS }));

	// One Claude Code for the session, started by its first artifact call and closed when idle.
	let server: ClaudeCode | undefined;
	let idle: NodeJS.Timeout | undefined;
	let running = 0;
	const closeServer = () => {
		clearTimeout(idle);
		server?.close();
		server = undefined;
	};
	pi.on("session_shutdown", closeServer);
	const call = async (name: typeof TOOLS[number], args: unknown, cwd: string, signal?: AbortSignal): Promise<McpResult> => {
		clearTimeout(idle);
		if (server?.cwd !== cwd || !server.running()) {
			closeServer();
			server = startClaudeCode(cwd, env);
		}
		const current = server;
		running++;
		try {
			return await current.request<McpResult>("tools/call", { name, arguments: args }, signal);
		} catch (error) {
			// A Claude Code that failed or timed out starts afresh on the next call.
			if (server === current) closeServer();
			throw error;
		} finally {
			running--;
			if (running === 0 && server) idle = setTimeout(closeServer, idleMs);
		}
	};

	// The definitions are Claude Code's, saved per installed binary so startup starts nothing. Only a
	// full list is saved: Claude Code lists only Artifact until it is signed in.
	const loaded = (async () => {
		const binary = await realpath(claude);
		const key = createHash("sha256").update(`${binary}:${(await stat(binary)).mtimeMs}`).digest("hex").slice(0, 16);
		const file = join(cacheDir, `${key}.json`);
		const cached: ClaudeTool[] | undefined = await readFile(file, "utf8").then(JSON.parse, () => undefined);
		const tools = cached ?? (await askClaudeCode<{ tools: ClaudeTool[] }>(tmpdir(), env, "tools/list", {})).tools.filter((tool) => TOOLS.includes(tool.name));
		for (const tool of tools) {
			pi.registerTool({
				name: `${TOOL_PREFIX}${tool.name}`,
				label: `claude-artifacts/${tool.name}`,
				description: tool.description,
				parameters: tool.inputSchema,
				exposure: "deferred",
				namespace: { name: NAMESPACE, description: "Claude Code's artifact tools: publish, read, update, list and delete claude.ai artifacts, their comments and their shared database." },
				annotations: tool.annotations,
				async execute(_id, params, signal, _onUpdate, ctx) {
					const result = await call(tool.name, params, ctx.cwd, signal);
					const content = result.content.filter((block) => block.type === "text" || block.type === "image");
					return { content, details: {}, isError: result.isError };
				},
			});
		}
		if (cached || tools.length < TOOLS.length) return;
		await mkdir(cacheDir, { recursive: true });
		await writeFile(file, JSON.stringify(tools));
	})().catch(() => undefined);
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[NAMESPACE] = PROMPT_SECTION;
	});
	// Claude Code forgets each call; keep the conversation's published files and seen versions.
	const publishedFiles = new Map<string, string>();
	const seenVersions = new Map<string, string>();
	const seenFiles = new Map<string, Map<string, string>>();
	// A large handed-over page, until every line of its saved file has been read.
	const unreadSaved = new Map<string, { id: string; version: string; unread: Set<number> }>();
	// Claude Code refuses a resend of the very content it refused once more, then lets it through.
	const refusedPages = new Map<string, { version: string; sha256: string }>();
	const sawFile = (id: string, file: FileRead) => {
		if ("error" in file) return;
		const files = seenFiles.get(id) ?? new Map<string, string>();
		seenFiles.set(id, files.set(file.path, file.sha256));
	};
	pi.on("session_start", () => {
		// Pi's MCP extension turns tool_search on only for deferred MCP servers.
		const active = pi.getActiveTools();
		if (!active.includes(TOOL_SEARCH) && pi.getAllTools().some((tool) => tool.name === TOOL_SEARCH && tool.reachesTools)) pi.setActiveTools([...active, TOOL_SEARCH]);
		publishedFiles.clear();
		seenVersions.clear();
		seenFiles.clear();
		unreadSaved.clear();
		refusedPages.clear();
	});
	function record(action: unknown, inputUrl: unknown, text: string) {
		let result: ArtifactResult | undefined;
		try {
			result = JSON.parse(text);
		} catch {}
		if (action === "publish") {
			if (!result?.artifact_id || !result.version) return;
			seenVersions.set(result.artifact_id, result.version);
			refusedPages.delete(result.artifact_id);
			if (result.path && result.url) publishedFiles.set(result.path, result.url);
			for (const row of result.files_written ?? []) sawFile(result.artifact_id, row);
			return;
		}
		// "[Artifact {uuid} (version {version}) — owned by you, ..." heads a page read.
		for (const [, id, version] of text.matchAll(/\[Artifact ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \(version ([^)\s]+)\)/g)) {
			seenVersions.set(id, version);
		}
		const id = artifactId(inputUrl);
		if (!id || !result) return;
		// A file listing, or a read of published files by `path` or `paths`.
		for (const row of [...(result.file_list?.files ?? []), ...(result.file_read ? [result.file_read] : []), ...(result.files_read?.files ?? [])]) sawFile(id, row);
	}

	// Claude Code deletes only after its own terminal confirmation, which `claude mcp serve` cannot
	// show, so its delete always refuses there. Pi asks instead and deletes through the same API.
	const deleted = new Map<string, { url: string; id: string }>();
	const unseenLive = new Map<string, { id: string; version: string }>();
	const pageHash = async (file: unknown, cwd: string) => {
		const content = typeof file === "string" ? await readFile(resolve(cwd, file)).catch(() => undefined) : undefined;
		return content && createHash("sha256").update(content).digest("hex");
	};
	pi.on("tool_call", async (event, ctx) => {
		// A search before the definitions have loaded waits for them.
		if (event.toolName === TOOL_SEARCH) await loaded;
		if (!isToolCallEventType<typeof ARTIFACT_TOOL, ArtifactInput>(ARTIFACT_TOOL, event)) return;
		const input = event.input;
		if (input.action === "delete") {
			const url = input.url;
			const id = artifactId(url);
			if (!url || !id) return;
			if (!ctx.hasUI) {
				return { block: true, reason: "Deleting a Claude artifact needs the user's confirmation, and this Pi session cannot ask. Nothing was deleted. The user can delete it from the artifact's menu on claude.ai." };
			}
			const choice = await ctx.ui.select(
				`Permanently delete this Claude artifact?\n\n${url}\n\nThe link stops working for everyone, including you. This cannot be undone.`,
				["Delete", "Keep"],
			);
			if (choice !== "Delete") return { block: true, reason: "The user did not confirm the delete, so nothing was deleted." };
			try {
				await deleteArtifact(id, ctx.signal);
			} catch (error) {
				return { block: true, reason: `The user confirmed, but the delete failed: ${(error as Error).message}` };
			}
			deleted.set(event.toolCallId, { url, id });
			return;
		}
		if ((input.action ?? "publish") !== "publish" || input.type_url !== undefined) return;
		// The same file redeploys to the same artifact, as the tool's description promises.
		if (input.url === undefined && typeof input.file_path === "string") {
			// Claude Code reports the real path (on macOS, /tmp is /private/tmp).
			const file = resolve(ctx.cwd, input.file_path);
			const url = publishedFiles.get(await realpath(file).catch(() => file));
			if (url) input.url = url;
		}
		// Bypass MCP's empty conversation only for the version and files seen unchanged.
		const id = artifactId(input.url);
		const live = id && (await liveArtifact(id, ctx.signal).catch(() => undefined));
		if (!id || !live) return;
		const refused = refusedPages.get(id);
		if (refused && refused.version === live.version && refused.sha256 === (await pageHash(input.file_path, ctx.cwd))) {
			refusedPages.delete(id);
			return {
				block: true,
				reason: `Publish refused — nothing was merged or published: this is the identical content already refused against the newer version ${live.version}, resent unchanged. ${live.version} is still the live version (checked just now) and its source has already reached you. If your content leaves out anything in that version, merge it in and publish the merged result; if, checked against that source, it genuinely already includes that version's changes, publish it again unchanged and it will go through unless the artifact changes again first.`,
			};
		}
		if (live.version !== seenVersions.get(id)) unseenLive.set(event.toolCallId, { id, version: live.version });
		else input.force = true;
		if (input.files === undefined && input.root === undefined) return;
		const seen = seenFiles.get(id);
		const unchanged = Object.entries(live.files).filter(([path, sha256]) => seen?.get(path) === sha256).map(([path]) => path);
		if (unchanged.length) input.overwrite_unread = [...new Set([...(input.overwrite_unread ?? []), ...unchanged])];
	});
	pi.on("tool_result", async (event, ctx) => {
		const removed = deleted.get(event.toolCallId);
		if (removed) {
			deleted.delete(event.toolCallId);
			for (const [file, url] of publishedFiles) if (artifactId(url) === removed.id) publishedFiles.delete(file);
			const text = JSON.stringify({ deleted: true, url: removed.url, artifact_id: removed.id, note: "Deleted after the user confirmed in Pi. The link no longer works." });
			return { content: [{ type: "text", text }], isError: false };
		}
		if (event.toolName === ARTIFACT_TOOL && !event.isError) record(event.input.action ?? "publish", event.input.url, resultText(event.content));
		const unseen = unseenLive.get(event.toolCallId);
		unseenLive.delete(event.toolCallId);
		// Claude Code reads the live version into a refusal and counts it as viewed (its "autoread").
		// Over MCP it cannot record that, and sometimes asks for a read instead, so Pi does both.
		if (unseen && event.isError) {
			const refusal = resultText(event.content);
			const pending = [...unreadSaved].find(([, saved]) => saved.id === unseen.id && saved.version === unseen.version);
			if (pending) {
				const [file, saved] = pending;
				const text = `${saved.unread.size} lines of ${file} have not been read yet. Version ${saved.version} counts as viewed once you have read every line of that file with the read tool.`;
				return { content: [...event.content, { type: "text", text }] };
			}
			const sha256 = await pageHash(event.input.file_path, ctx.cwd);
			if (sha256) refusedPages.set(unseen.id, { version: unseen.version, sha256 });
			else refusedPages.delete(unseen.id);
			// "Its full source (97.6KB) is saved at /path: Read every line of that file (1237 lines; ..."
			const saved = refusal.match(/is saved at (\S+?): Read every line of that file \((\d+) lines/);
			if (saved) {
				const file = await realpath(saved[1]).catch(() => saved[1]);
				unreadSaved.set(file, { id: unseen.id, version: unseen.version, unread: new Set(Array.from({ length: Number(saved[2]) }, (_, line) => line + 1)) });
				return;
			}
			if (refusal.includes("live version; raw HTML follows")) {
				seenVersions.set(unseen.id, unseen.version);
				return;
			}
			const read = await call("Artifact", { action: "read", url: event.input.url }, ctx.cwd, ctx.signal).then((result) => resultText(result.content), () => undefined);
			if (!read) return;
			record("read", event.input.url, read);
			const text = `Pi has read the live version for you with Claude Code's read, which follows, so it now counts as viewed and there is no need to read it again. Merge your edits onto it so no published content is lost, then publish again; do not resend your previous content unchanged.\n${read}`;
			return { content: [...event.content, { type: "text", text }] };
		}
		// Count the lines of a saved live page the model has read with Pi's read tool.
		if (isReadToolResult(event) && !event.isError && unreadSaved.size > 0) {
			const { path, offset, limit } = event.input as { path: string; offset?: number | null; limit?: number | null };
			const file = await realpath(resolve(ctx.cwd, path)).catch(() => "");
			const saved = unreadSaved.get(file);
			if (!saved) return;
			const first = offset ?? 1;
			const truncation = event.details?.truncation;
			const count = truncation?.truncated ? truncation.outputLines : limit ?? Infinity;
			for (const line of saved.unread) if (line >= first && line < first + count) saved.unread.delete(line);
			if (saved.unread.size === 0) {
				seenVersions.set(saved.id, saved.version);
				unreadSaved.delete(file);
			}
			return;
		}
		// Over MCP, Claude Code reports `opened` without opening a browser, so Pi opens the link.
		if (event.toolName !== ARTIFACT_TOOL || event.input.action !== "open" || event.isError) return;
		const note = !ctx.hasUI
			? "This Pi session has no screen to open it on. Give the user the link."
			: await openUrl(String(event.input.url)).then(() => "Pi opened it in the user's browser.", (error: Error) => `Pi could not open it (${error.message}). Give the user the link.`);
		return { content: [...event.content, { type: "text", text: note }] };
	});
}
