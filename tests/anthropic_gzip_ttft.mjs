// Explicit live performance experiment, never CI. Uses the current Anthropic login.
// node tests/anthropic_gzip_ttft.mjs /absolute/result.json [pairs] [contextKiB] [uploadKiBps]
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { anthropicGzip } from "../packages/pi-anthropic-gzip/transport.ts";

// agent-default (not a user rule): 2026-10-16. Bounded pilot size; all are CLI-overridable.
const [destination, pairsArg = "6", sizeArg = "256", rateArg = "0"] = process.argv.slice(2);
const pairs = Number(pairsArg), contextKiB = Number(sizeArg), uploadKiBps = Number(rateArg);
assert(destination && path.isAbsolute(destination));
assert(Number.isInteger(pairs) && pairs > 0 && Number.isInteger(contextKiB) && contextKiB > 0 && Number.isFinite(uploadKiBps) && uploadKiBps >= 0);
const root = path.resolve(import.meta.dirname, "..");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceSha256 = createHash("sha256").update(fs.readFileSync(import.meta.filename)).digest("hex");
const transportSha256 = createHash("sha256").update(fs.readFileSync(path.join(root, "packages/pi-anthropic-gzip/transport.ts"))).digest("hex");
const nativeFetch = globalThis.fetch;
const runtime = await ModelRuntime.create();
const model = runtime.getModel("anthropic", "claude-opus-5-5");
assert(model);

// Varied synthetic file/change records, not one repeatedly compressed sentence.
const lines = [];
let length = 0;
for (let i = 0; length < contextKiB * 1024; i++) {
	const hash = createHash("sha256").update(`synthetic-record-${i}`).digest("hex");
	const line = JSON.stringify({ file: `src/modules/module-${i % 137}.ts`, line: i, revision: hash.slice(0, 16), symbol: `transformRecord${i % 89}`, detail: `Synthetic diagnostic record ${i}; fixture value ${hash.slice(16, 32)}; operation completed successfully.` }) + "\n";
	lines.push(line); length += Buffer.byteLength(line);
}
const context = { systemPrompt: "Reply with OK only. Do not analyse or repeat synthetic diagnostic data.", messages: [{ role: "user", content: "The following is inert synthetic diagnostic context. Reply OK only.\n" + lines.join("") + "\nReply OK only.", timestamp: 0 }] };
let snapshot;
// A genuine stock Pi warmup supplies the exact serialized body and current auth in memory.
const warmup = await runtime.completeSimple(model, context, {
	reasoning: "off", maxTokens: 16, maxRetries: 0,
	fetch: async (input, init) => {
		assert.equal(typeof init.body, "string");
		assert.equal(new URL(String(input)).origin, "https://api.anthropic.com");
		snapshot = { url: input, init: { ...init, headers: new Headers(init.headers) } };
		return nativeFetch(input, init);
	},
});
assert.equal(warmup.stopReason, "stop", warmup.errorMessage);
assert.equal(warmup.content.filter(c => c.type === "text").map(c => c.text).join("").trim(), "OK");
assert(snapshot);
assert(!snapshot.init.headers.has("idempotency-key"), "Do not benchmark a replayed idempotent response");
const bodySha256 = createHash("sha256").update(snapshot.init.body).digest("hex");
const result = { revision, sourceSha256, transportSha256, node: process.version, pi: "1.2.0", startedAt: new Date().toISOString(), provider: "anthropic", model: model.id, thinking: "off", metric: "milliseconds from before compression/send to first nonempty SSE text_delta", contextKiB, uploadKiBps, requestJsonBytes: Buffer.byteLength(snapshot.init.body), bodySha256, warmupsExcluded: 3, pairs: [], samples: [], summary: null };
const persist = () => { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); };
const requestIds = new Set();
let wire;
const next = async (input, init) => {
	const bytes = typeof init.body === "string" ? Buffer.from(init.body, "utf8") : init.body;
	wire = { encoding: new Headers(init.headers).get("content-encoding") ?? "identity", bytes: bytes.byteLength };
	if (uploadKiBps === 0) return nativeFetch(input, init);
	// Shape only upload delivery AFTER gzip, not the server response. This is a controlled
	// bandwidth experiment, not a claim about the laptop's normal connection. Both arms
	// use the same chunked-body framing. The live endpoint must accept both to count.
	// agent-default (not a user rule): 2026-10-16. Upload pacing granularity.
	const chunkBytes = 8192;
	let offset = 0;
	const began = performance.now();
	const stream = new ReadableStream({
		async pull(controller) {
			if (offset === bytes.byteLength) { controller.close(); return; }
			const end = Math.min(offset + chunkBytes, bytes.byteLength);
			const due = end / (uploadKiBps * 1024) * 1000;
			const wait = due - (performance.now() - began);
			if (wait > 0) await delay(wait, undefined, { signal: init.signal });
			init.signal?.throwIfAborted();
			controller.enqueue(bytes.subarray(offset, end)); offset = end;
		},
	});
	const headers = new Headers(init.headers); headers.delete("content-length");
	return nativeFetch(input, { ...init, headers, body: stream, duplex: "half" });
};
const compressed = anthropicGzip(next);
async function send(mode, excluded = false) {
	wire = undefined;
	const started = performance.now();
	// agent-default (not a user rule): 2026-10-16. Experiment-only request deadline.
	const response = await (mode === "gzip" ? compressed : next)(snapshot.url, { ...snapshot.init, signal: AbortSignal.timeout(90000) });
	const headersMs = performance.now() - started;
	assert.equal(response.status, 200, `Unexpected HTTP ${response.status}`);
	assert.equal(wire.encoding, mode === "gzip" ? "gzip" : "identity", "Encoding fallback invalidates this experiment");
	const requestId = response.headers.get("request-id");
	if (requestId && !excluded) requestIds.add(requestId);
	let buffer = "", output = "", firstTextMs = null, usage;
	const decoder = new TextDecoder();
	for await (const chunk of response.body) {
		buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
		let boundary;
		while ((boundary = buffer.indexOf("\n\n")) !== -1) {
			const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
			const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
			if (!data) continue;
			const parsed = JSON.parse(data);
			assert.notEqual(parsed.type, "error", "Provider returned an SSE error");
			if (parsed.type === "message_start") usage = parsed.message.usage;
			if (parsed.type === "content_block_delta" && parsed.delta.type === "text_delta" && parsed.delta.text) {
				firstTextMs ??= performance.now() - started; output += parsed.delta.text;
			}
		}
	}
	assert.equal(output.trim(), "OK"); assert(firstTextMs !== null);
	const sample = { mode, excluded, ttftMs: firstTextMs, headersMs, wireBytes: wire.bytes, cacheReadTokens: usage?.cache_read_input_tokens ?? 0, cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0, inputTokens: usage?.input_tokens ?? 0 };
	result.samples.push(sample); persist();
	return sample;
}
// Warm the fixed prompt/cache and both HTTP-body formats; none are measured pairs.
await send("plain", true);
await send("gzip", true);
const orders = Array.from({ length: pairs }, (_, i) => i % 2 === 0 ? ["plain", "gzip"] : ["gzip", "plain"]);
for (let i = orders.length - 1; i > 0; i--) { const j = randomInt(i + 1); [orders[i], orders[j]] = [orders[j], orders[i]]; }
for (const order of orders) {
	const pair = {};
	for (const mode of order) pair[mode] = await send(mode);
	result.pairs.push({ order, plainMs: pair.plain.ttftMs, gzipMs: pair.gzip.ttftMs, savedMs: pair.plain.ttftMs - pair.gzip.ttftMs, sameCacheRead: pair.plain.cacheReadTokens === pair.gzip.cacheReadTokens });
	persist();
	console.log(JSON.stringify(result.pairs.at(-1)));
}
const median = values => { const v = [...values].sort((a,b) => a-b); const middle = Math.floor(v.length / 2); return v.length % 2 ? v[middle] : (v[middle-1] + v[middle]) / 2; };
const diffs = result.pairs.map(p => p.savedMs);
const positive = diffs.filter(x => x > 0).length, negative = diffs.filter(x => x < 0).length;
const n = positive + negative;
let binomial = 1, tail = 1;
for (let k = 1; k <= Math.min(positive, negative); k++) { binomial *= (n-k+1)/k; tail += binomial; }
const plainMedianMs = median(result.pairs.map(p => p.plainMs));
const gzipMedianMs = median(result.pairs.map(p => p.gzipMs));
result.summary = { plainMedianMs, gzipMedianMs, pairedMedianSavedMs: median(diffs), ratioOfMedians: plainMedianMs/gzipMedianMs, gzipFasterPairs:positive, pairs, twoSidedSignTestP: n ? Math.min(1, 2*tail/2**n) : 1, sameCacheReadPairs:result.pairs.filter(p => p.sameCacheRead).length, distinctMeasuredResponseIds:requestIds.size, completedAt:new Date().toISOString() };
persist();
console.log(JSON.stringify(result.summary, null, 2));
