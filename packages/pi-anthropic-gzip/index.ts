import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicGzip, type Fetch } from "./transport.ts";

const SLOT = Symbol.for("@tmustier/pi-anthropic-gzip/transport/v1");
interface Installation {
	readonly next: Fetch;
	readonly fetch: Fetch;
	dispatch: Fetch;
	owners: Set<symbol>;
}
type FetchHost = { fetch: Fetch; [SLOT]?: Installation };

/** A stable dispatcher also serves SDK clients that cached fetch before /reload. */
export function installAnthropicGzip(host: FetchHost): () => void {
	const state = host[SLOT] ??= {
		next: host.fetch,
		fetch: (input, init): ReturnType<Fetch> => state.dispatch(input, init),
		dispatch: host.fetch,
		owners: new Set<symbol>(),
	};
	if (state.owners.size === 0) {
		// Only reattach to our predecessor: another wrapper may already delegate to us.
		if (host.fetch === state.next) host.fetch = state.fetch;
		state.dispatch = anthropicGzip(state.next);
	}
	const owner = Symbol();
	state.owners.add(owner);
	return () => {
		if (!state.owners.delete(owner) || state.owners.size !== 0) return;
		state.dispatch = state.next;
		if (host.fetch === state.fetch) host.fetch = state.next;
	};
}

export default function (pi: ExtensionAPI): void {
	let release: (() => void) | undefined;
	pi.on("session_start", () => { release ??= installAnthropicGzip(globalThis); });
	pi.on("session_shutdown", () => {
		release?.();
		release = undefined;
	});
}
