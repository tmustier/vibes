import { randomInt } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

export type Fetch = typeof globalThis.fetch;
const gzipAsync = promisify(gzip);
// agent-default (not a user rule): 2026-10-16. Match Claude Code 2.1.302.
const MIN_BODY_CHARACTERS = 4096;
// agent-default (not a user rule): 2026-10-16. Match Claude Code's trailing JSON whitespace.
const MAX_PADDING_CHARACTERS = 256;
/** Wrap only the verified direct Messages wire format; keep the caller's transport. */
export function anthropicGzip(next: Fetch): Fetch {
	let rejected = false;
	return async (input, init) => {
		// Do not consume Request-owned bodies, buffers, forms or streams.
		if (rejected || init?.method?.toUpperCase() !== "POST" || typeof init.body !== "string" ||
			init.body.length < MIN_BODY_CHARACTERS) return next(input, init);
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const headers = new Headers(init.headers);
		if (url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages" ||
			headers.has("content-encoding") ||
			headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return next(input, init);

		init.signal?.throwIfAborted();
		const padding = Array.from({ length: randomInt(MAX_PADDING_CHARACTERS + 1) },
			() => randomInt(2) === 0 ? " " : "\t").join("");
		// One gzip member containing the complete UTF-8 JSON, not separately gzipped history chunks.
		const body = Uint8Array.from(await gzipAsync(Buffer.from(`${init.body}\n${padding}`, "utf8")));
		init.signal?.throwIfAborted();
		headers.set("content-encoding", "gzip");
		headers.delete("content-length");
		const response = await next(input, { ...init, headers, body });
		if (![400, 403, 415].includes(response.status)) return response;
		const fromAnthropic = response.headers.get("request-id")?.startsWith("req_") || response.headers.has("cf-ray");
		if (fromAnthropic) {
			if (response.status !== 400) return response;
			try {
				const body: unknown = await response.clone().json();
				if (typeof body !== "object" || body === null || !("error" in body)) return response;
				const error = body.error;
				if (typeof error !== "object" || error === null || !("type" in error) ||
					error.type !== "invalid_request_error" || !("message" in error) || typeof error.message !== "string") return response;
				if (!error.message.startsWith("The request body is not valid JSON") &&
					!error.message.startsWith("Failed to parse request: could not parse request body as JSON")) return response;
			} catch {
				return response;
			}
		}
		// Retry explicit encoding rejections, not ambiguous network failures or origin auth errors.
		rejected = true;
		await response.body?.cancel();
		init.signal?.throwIfAborted();
		return next(input, init);
	};
}
