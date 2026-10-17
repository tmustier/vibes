import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { anthropicGzip, type Fetch } from "./transport.ts";
import { installAnthropicGzip } from "./index.ts";

const endpoint = "https://api.anthropic.com/v1/messages?beta=true";
const payload = { model: "test-model", messages: [{ role: "user", content: "日本語 café 👋\n".repeat(600) }] };
const json = JSON.stringify(payload);
const init = (): RequestInit => ({ method: "POST", headers: { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(json)), authorization: "fixture-only" }, body: json });
function decode(request: RequestInit | undefined) {
	assert(request?.body instanceof Uint8Array);
	return JSON.parse(gunzipSync(request.body).toString("utf8"));
}
function recorder(respond: (request: RequestInit | undefined, count: number) => Response | Promise<Response> = () => new Response("OK")) {
	const calls: Array<{ input: Parameters<Fetch>[0]; init: RequestInit | undefined }> = [];
	const fetch: Fetch = async (input, init) => { calls.push({ input, init }); return respond(init, calls.length); };
	return { calls, fetch };
}

test("one gzip member preserves Unicode JSON, headers, options and streaming response", async () => {
	const response = new Response("data: fixture\n\n", { headers: { "content-type": "text/event-stream" } });
	const r = recorder(() => response);
	const signal = new AbortController().signal;
	const original = { ...init(), signal, redirect: "error" as const };
	const before = structuredClone(original.headers);
	assert.equal(await anthropicGzip(r.fetch)(endpoint, original), response);
	const wire = r.calls[0]!;
	assert.equal(wire.input, endpoint);
	assert.deepEqual(decode(wire.init), payload);
	assert(wire.init?.body instanceof Uint8Array);
	const bytes = wire.init.body;
	assert(bytes.byteLength < Buffer.byteLength(json));
	const inflated = gunzipSync(bytes).toString("utf8");
	assert.match(inflated.slice(json.length), /^\n[ \t]{0,256}$/);
	const headers = new Headers(wire.init.headers);
	assert.equal(headers.get("content-encoding"), "gzip");
	assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
	assert.equal(headers.get("authorization"), "fixture-only");
	assert.equal(headers.get("content-length"), null);
	assert.equal(wire.init.signal, signal);
	assert.equal(wire.init.redirect, "error");
	assert.deepEqual(original.headers, before);
	assert.equal(original.body, json);
	assert.equal(await response.text(), "data: fixture\n\n");
});

test("all unverified origins, formats and small bodies pass through unchanged", async () => {
	const cases: Array<[Parameters<Fetch>[0], RequestInit | undefined]> = [
		["https://gateway.example/v1/messages", init()],
		["https://api.anthropic.com.evil.example/v1/messages", init()],
		["http://api.anthropic.com/v1/messages", init()],
		["https://api.anthropic.com:8443/v1/messages", init()],
		["https://api.anthropic.com/v1/messages/count_tokens", init()],
		["https://api.anthropic.com/v1/messages/batches", init()],
		[endpoint, { ...init(), method: "GET" }],
		[endpoint, { ...init(), headers: { "content-type": "text/plain" } }],
		[endpoint, { ...init(), headers: { "content-type": "application/json", "content-encoding": "gzip" } }],
		[endpoint, { ...init(), headers: { "content-type": "application/json", "content-encoding": "identity" } }],
		[endpoint, { ...init(), body: "{}" }],
		[endpoint, { ...init(), body: new Uint8Array(8000) }],
		[new Request(endpoint, init()), undefined],
		[endpoint, undefined],
	];
	for (const [url, request] of cases) {
		const r = recorder();
		await anthropicGzip(r.fetch)(url, request);
		assert.equal(r.calls.length, 1);
		assert.equal(r.calls[0]!.input, url);
		assert.equal(r.calls[0]!.init, request);
	}
});

test("accepts URL input and the Claude Code size boundary", async () => {
	for (const length of [4095, 4096]) {
		const r = recorder();
		await anthropicGzip(r.fetch)(new URL(endpoint), { ...init(), body: JSON.stringify("x".repeat(length - 2)) });
		assert.equal(new Headers(r.calls[0]!.init!.headers).get("content-encoding"), length === 4096 ? "gzip" : null);
	}
});

for (const rejection of [
	new Response("unsupported", { status: 415 }),
	new Response("proxy forbids this encoding", { status: 403 }),
	new Response("proxy cannot parse this encoding", { status: 400 }),
	new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "The request body is not valid JSON: EOF" } }), { status: 400, headers: { "request-id": "req_fixture" } }),
]) {
	test(`explicit rejection ${rejection.status} retries original once and disables later compression`, async () => {
		const r = recorder((_request, n) => n === 1 ? rejection : new Response("OK"));
		const fetch = anthropicGzip(r.fetch);
		const original = init();
		assert.equal(await (await fetch(endpoint, original)).text(), "OK");
		assert.equal(r.calls.length, 2);
		assert.deepEqual(decode(r.calls[0]!.init), payload);
		assert.equal(r.calls[1]!.init, original);
		await fetch(endpoint, original);
		assert.equal(r.calls[2]!.init, original);
	});
}

test("ordinary application, auth, rate and server errors are not replayed or consumed", async () => {
	for (const status of [400, 401, 403, 413, 415, 429, 500, 503]) {
		const response = new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "model is invalid" } }), { status, headers: { "request-id": "req_fixture" } });
		const r = recorder(() => response);
		assert.equal(await anthropicGzip(r.fetch)(endpoint, init()), response);
		assert.equal(r.calls.length, 1);
		assert.match(await response.text(), /model is invalid/);
	}
	const r = recorder(() => new Response("not JSON", { status: 400, headers: { "cf-ray": "fixture" } }));
	const response = await anthropicGzip(r.fetch)(endpoint, init());
	assert.equal(await response.text(), "not JSON");
	assert.equal(r.calls.length, 1);
});

test("network failures are not replayed", async () => {
	const error = new Error("ambiguous network failure");
	const r = recorder(() => { throw error; });
	await assert.rejects(anthropicGzip(r.fetch)(endpoint, init()), (e) => e === error);
	assert.equal(r.calls.length, 1);
});

test("abort before/during compression never dispatches, and abort prevents fallback", async () => {
	for (const during of [false, true]) {
		const controller = new AbortController();
		const r = recorder();
		if (!during) controller.abort();
		const pending = anthropicGzip(r.fetch)(endpoint, { ...init(), signal: controller.signal });
		if (during) controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		assert.equal(r.calls.length, 0);
	}
	const controller = new AbortController();
	const r = recorder(() => { controller.abort(); return new Response(null, { status: 415 }); });
	await assert.rejects(anthropicGzip(r.fetch)(endpoint, { ...init(), signal: controller.signal }), { name: "AbortError" });
	assert.equal(r.calls.length, 1);
});

test("install/rebind/reload/disable preserves one dispatcher, including cached SDK fetch", async () => {
	const r = recorder();
	const host = { fetch: r.fetch };
	const stopA = installAnthropicGzip(host);
	const cached = host.fetch;
	const stopB = installAnthropicGzip(host);
	assert.equal(host.fetch, cached);
	await cached(endpoint, init()); assert.deepEqual(decode(r.calls.at(-1)!.init), payload);
	stopA(); stopA();
	await host.fetch(endpoint, init()); assert.deepEqual(decode(r.calls.at(-1)!.init), payload);
	stopB();
	assert.equal(host.fetch, r.fetch);
	const plain = init();
	await cached(endpoint, plain); assert.equal(r.calls.at(-1)!.init, plain);
	const stopReload = installAnthropicGzip(host);
	assert.equal(host.fetch, cached);
	await cached(endpoint, init()); assert.deepEqual(decode(r.calls.at(-1)!.init), payload);
	stopReload();
	assert.equal(host.fetch, r.fetch);
});

test("another fetch wrapper retains ownership and reload cannot introduce a dispatch cycle", async () => {
	const r = recorder();
	const host = { fetch: r.fetch };
	const release = installAnthropicGzip(host);
	const inner = host.fetch;
	let outerCalls = 0;
	const outer: Fetch = (input, init) => { outerCalls++; return inner(input, init); };
	host.fetch = outer;
	release();
	assert.equal(host.fetch, outer);
	const plain = init(); await host.fetch(endpoint, plain);
	assert.equal(r.calls.at(-1)!.init, plain);
	const stop = installAnthropicGzip(host);
	assert.equal(host.fetch, outer);
	await host.fetch(endpoint, init()); assert.deepEqual(decode(r.calls.at(-1)!.init), payload);
	assert.equal(outerCalls, 2);
	stop(); assert.equal(host.fetch, outer);
});

test("reload recovers when a third party restored the exact preceding fetch", async () => {
	const r = recorder();
	const host = { fetch: r.fetch };
	const stop = installAnthropicGzip(host);
	const dispatcher = host.fetch;
	host.fetch = r.fetch;
	stop();
	const restart = installAnthropicGzip(host);
	assert.equal(host.fetch, dispatcher);
	await host.fetch(endpoint, init());
	assert.deepEqual(decode(r.calls.at(-1)!.init), payload);
	restart();
	assert.equal(host.fetch, r.fetch);
});
