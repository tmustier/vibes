import { execFile, type ExecFileOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { archivedError, ThreadState, type Checkpoint } from "./protocol.ts";

function amp(args: string[], options: ExecFileOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile("amp", args, { ...options, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
		// Amp also reads piped stdin in execute mode, even with a literal argument.
		child.stdin?.end();
	});
}
const ampOrigin = () => new URL(process.env.AMP_URL ?? "https://ampcode.com/").origin;

/** The active CLI account's credential for this server: matching server, user and login session. */
async function apiKey(origin: string): Promise<string> {
	if (process.env.AMP_API_KEY) return process.env.AMP_API_KEY;
	const root = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "amp");
	const read = async (file: string) => JSON.parse(await readFile(join(root, file), "utf8"));
	const server = `${origin}/`;
	try {
		const accounts = await read("accounts.json");
		const account = accounts.accounts.find((a: { userID: string; serverURL: string }) => a.userID === accounts.active[server] && a.serverURL === server);
		const [file, key] = account.legacy
			? ["secrets.json", `apiKey@${account.legacyURL ?? server}`]
			: ["accounts/secrets.json", `apiKey@${server}#cli-account=${account.userID}&session=${account.sessionID}`];
		const secret = (await read(file))[key];
		if (typeof secret === "string" && secret) return secret;
	} catch {}
	throw new Error("Amp CLI credential unavailable; run amp login (or set AMP_API_KEY)");
}

type Socket = Pick<WebSocket, "send" | "close" | "addEventListener">;
type OpenActor = (threadId: string, capability: "read" | "write", signal: AbortSignal) => Promise<{ socket: Socket; version: number }>;
export const openActor: OpenActor = async (threadId, capability, signal) => {
	const origin = ampOrigin();
	const authorize = async () => fetch(`${origin}/api/thread-actors`, { method: "POST", signal, headers: { Authorization: `Bearer ${await apiKey(origin)}`, "Content-Type": "application/json" }, body: JSON.stringify({ threadId, capability }) });
	let response = await authorize();
	if (response.status === 401 && !process.env.AMP_API_KEY) {
		// Let the CLI own OAuth refresh and its account store. Never copy refresh tokens.
		await amp(["usage"], { signal, timeout: 30000 }).catch(() => { throw new Error("Amp credential refresh failed; run amp login"); });
		response = await authorize();
	}
	if (!response.ok) {
		// Read only Amp's machine-readable code; other error bodies may carry private detail.
		const code = response.status === 409 ? await response.json().then((body) => body?.code, () => undefined) : undefined;
		throw new Error(code === "THREAD_ARCHIVED" ? archivedError : `Amp actor authorization failed (HTTP ${response.status})`);
	}
	const { wsToken, threadVersion } = await response.json();
	if (typeof wsToken !== "string" || typeof threadVersion !== "number") throw new Error("Amp actor authorization response changed; update amp-orbs");

	// Amp's page embeds its Rivet gateway as https://<namespace>:<token>@host/path. Read it as data only.
	const page = await fetch(origin, { signal });
	const baseURL = /threadActorConfig:\s*\{\s*baseURL:\s*("(?:[^"\\]|\\.)*")/.exec(await page.text())?.[1];
	if (!page.ok || !baseURL) throw new Error("Amp actor endpoint discovery changed; update amp-orbs");
	const gateway = new URL(JSON.parse(baseURL));
	const url = new URL(`${gateway.origin}${gateway.pathname}/gateway/threadActor/websocket/`);
	url.search = new URLSearchParams({
		"rvt-namespace": decodeURIComponent(gateway.username), "rvt-method": "get", "rvt-key": threadId,
		"rvt-token": decodeURIComponent(gateway.password), "rvt-skip-ready-wait": "true",
	}).toString();
	const params = encodeURIComponent(JSON.stringify({ wsToken, transport: "json-rpc" }));
	return { socket: new WebSocket(url, ["rivet", "rivet_encoding.bare", "rivet_skip_ready_wait", `rivet_conn_params.${params}`]), version: threadVersion };
};

type Observable = { subscribe(listener: () => void): () => void };
/** Resolve true once done() holds after a change, or false on timeout. Abort rejects; remote work is untouched. */
export function waitFor(threads: Observable[], done: () => boolean, signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const finish = (settle: () => void) => {
			clearTimeout(timer); offs.forEach((off) => off()); signal?.removeEventListener("abort", abort);
			settle();
		};
		const abort = () => finish(() => reject(new Error("Amp wait cancelled; remote work continues")));
		const check = () => { if (done()) finish(() => resolve(true)); };
		const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(() => resolve(false)), timeoutMs);
		const offs = threads.map((thread) => thread.subscribe(check));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort(); else check();
	});
}

export class ThreadConnection {
	readonly state: ThreadState;
	private listeners = new Set<() => void>();
	private socket?: Socket;
	private controller?: AbortController;
	private retry?: ReturnType<typeof setTimeout>;
	private handshake?: ReturnType<typeof setTimeout>;
	private generation = 0;
	private attempt = 0;
	private requestId = 1;
	private pending = new Map<number, { resolve: (accepted: boolean) => void; reject: (error: Error) => void }>();
	private capability: "read" | "write" = "read";
	private open: OpenActor;

	constructor(threadId: string, checkpoint: Checkpoint = {}, open = openActor) {
		this.state = new ThreadState(threadId, ampOrigin(), checkpoint);
		this.open = open;
	}
	subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	private changed() { for (const listener of this.listeners) listener(); }

	/** Close the transport and cancel any reconnect. Events from it are ignored from now on. */
	stop() {
		this.generation++;
		clearTimeout(this.retry); clearTimeout(this.handshake);
		this.controller?.abort(); this.socket?.close();
	}
	/** (Re)connect with a fresh authorization, then synchronize a snapshot and resume acknowledgement. */
	start() {
		this.stop();
		const generation = this.generation;
		const current = () => generation === this.generation;
		this.controller = new AbortController();
		const fail = (message: string) => {
			if (!current()) return;
			this.stop();
			const archived = message === archivedError;
			if (archived) this.state.archive(); else this.state.disconnect(message);
			for (const pending of this.pending.values()) pending.reject(new Error("Amp disconnected; message acknowledgement unknown. Read status before retrying."));
			this.changed();
			// Reconnect only after a transport failure, never poll idle work or an archived thread.
			if (!archived) this.retry = setTimeout(() => this.start(), Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)));
		};
		const receive = (data: string) => {
			if (data === "pong") return;
			const frame = JSON.parse(data);
			if (frame.id === 1 && frame.error) return fail("Amp resume rejected");
			if (frame.id > 1) this.pending.get(frame.id)?.resolve(!frame.error && frame.result?.ok === true);
			else this.state.apply(frame);
			if (this.state.status.connection === "connected") { clearTimeout(this.handshake); this.attempt = 0; }
			this.changed();
		};
		this.state.resetConnection(); this.changed();
		this.handshake = setTimeout(() => fail("Amp actor synchronization timed out"), 30000);
		// Report only our own errors: platform errors can quote URLs that carry tokens.
		this.open(this.state.status.threadId, this.capability, this.controller.signal).then(({ socket, version }) => {
			if (!current()) return socket.close();
			this.socket = socket;
			socket.addEventListener("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "client_resume", params: { version } })));
			socket.addEventListener("close", () => fail("Amp actor disconnected"));
			socket.addEventListener("error", () => fail("Amp actor transport error"));
			socket.addEventListener("message", (event) => {
				if (!current()) return;
				try { receive(String(event.data)); } catch { fail("Invalid Amp actor frame"); }
			});
		}, (error) => fail(error instanceof Error && error.message.startsWith("Amp ") ? error.message : "Amp actor connection failed"));
	}
	/** Wait until synchronized; reconnect at once if disconnected. */
	async ready(signal?: AbortSignal) {
		if (this.state.status.connection === "disconnected") this.start();
		await waitFor([this], () => this.state.status.connection !== "connecting", signal);
		if (this.state.status.connection !== "connected") throw new Error(this.state.status.connectionError);
	}
	async send(text: string, signal?: AbortSignal) {
		if (this.capability === "read") { this.capability = "write"; this.start(); }
		await this.ready(signal);
		this.state.assertCanSend();
		const id = ++this.requestId;
		const messageId = `M-${randomUUID().replaceAll("-", "").slice(0, 22)}`;
		this.state.rearm();
		this.socket!.send(JSON.stringify({ jsonrpc: "2.0", id, method: "client_append_user_msg", params: { content: [{ type: "text", text }], agentMode: this.state.status.agentMode, messageId, steer: true } }));
		const accepted = await new Promise<boolean>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			const deadline = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
			deadline.addEventListener("abort", () => reject(new Error("Amp acknowledgement not received; delivery may have occurred. Read status before retrying.")));
		}).finally(() => this.pending.delete(id));
		if (!accepted) {
			// Nothing was appended. Restore settling and read a fresh snapshot; never retry the write.
			this.state.cancelRearm();
			this.start();
			throw new Error("Amp rejected the message");
		}
		return { accepted, messageId };
	}
}

type LaunchOptions = { prompt: string; cwd: string; mode: string; title?: string; project?: string; features?: string[] };
export async function launch({ prompt, cwd, mode, title, project, features }: LaunchOptions, signal?: AbortSignal): Promise<string> {
	const args = ["-ox", prompt, "-m", mode, "--no-color", "--no-archive-after-execute"];
	if (title) args.push("--title", title);
	if (project) args.push("--project", project);
	if (features?.length) args.push("--features", features.join(","));
	const stdout = await amp(args, { cwd, signal, timeout: 120000 }).catch(() => {
		throw new Error("Amp orb launch failed or was cancelled; check amp threads list before retrying (a remote thread may already exist)");
	});
	const id = stdout.match(/\bT-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)?.[0];
	if (!id) throw new Error("Amp launch returned no canonical thread ID; check amp threads list before retrying");
	return id;
}
