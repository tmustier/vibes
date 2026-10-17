# Granola MCP initialization timeout

If Granola's saved OAuth login works but its `mcp-remote@0.1.38` connection times out before listing tools, this compatibility fix may help. Reauthentication does not address an initialization transport failure.

## Apply the compatibility fix

Keep the existing Granola command, arguments and credentials. Add this environment entry to the `granola` server in `~/.pi/agent/mcp.json`, adapting the absolute path if the checkout is elsewhere:

```json
"env": {
  "NODE_OPTIONS": "--require=/absolute/path/to/vibes/lib/granola-mcp-fetch.cjs"
}
```

Preserve any other environment entries. If `NODE_OPTIONS` is already set, append the preload instead of replacing its flags. Run `pi mcp list --json`, then `/reload` in the affected Pi session. Granola should show `connected` with six tools. Ask Pi which Granola account is connected to verify a real `get_account_info` tool call.

The preload only changes the HTTP request for `notifications/initialized` at `https://mcp.granola.ai/mcp`. Authentication, token refresh, tool requests and other servers still use the original `fetch`. It does not store credentials or open a browser.

## Cause and verification

On 8 October 2026, live probes captured Granola's HTTP 202 for the initialization notification with `Transfer-Encoding: chunked` and an unfinished empty acknowledgement body. Node 26.10.0's `fetch` did not expose the live response before its abort timeout. The wrapper's initialization never completed and Pi timed out after 60 seconds. The lower-level HTTP client consistently received the 202 headers within a second. This isolates the failure to the live HTTP acknowledgement path, not the OAuth token or tool execution.

The preload reads the actual status and headers through Node's HTTP client. On a real 202 acknowledgement, it releases the response socket immediately. It does not invent a success, skip the notification or suppress rejected statuses. HTTP error bodies and OAuth challenge headers remain available to the wrapper, and abort signals cancel the request.

`node --test tests/test_granola_mcp_fetch.mjs` checks acknowledgement cleanup against a local unfinished chunked response, authentication errors, cancellation and routing scope. The local fixture does not reproduce the live server's native fetch stall. Live verification must also use the real Granola server through a model, not just `pi mcp list`.

A Pi 1.1.0 verification on 8 October 2026 used `openai-codex/gpt-6.1-sol` with medium thinking. The read-only prompt asked the model to discover and call `get_account_info`, without reading meetings or signing in. The recorded tool execution succeeded and returned the expected personal account and workspace. Six tools were discovered. Refreshing an expired token and meeting-content tools were not exercised.

Remove the preload flag after Granola fixes its response framing or after switching to a transport that demonstrably handles it. Other `NODE_OPTIONS` flags should remain.
