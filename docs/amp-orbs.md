# Amp orb tools (opt-in)

Enable `"amp-orbs": true` in the `features` map in `~/.pi/agent/vibes.json`, then `/reload`. This loads Vibes' installed `extensions/amp-orbs.ts`, not a worktree. Requires an authenticated `amp` CLI on PATH. Existing subagent tools are unchanged.

| Tool | Input | Behavior |
|---|---|---|
| `create_thread` | `prompt`, absolute local `cwd`, `mode`; optional `project`, `title`, `features[]` | Launches `amp -ox` with the literal prompt; returns canonical ID/URL immediately. `project` selects the Amp project/repository; otherwise Amp infers it from cwd's remotes. |
| `get_thread_status` | `threadId` | Synchronizes the direct observer; returns state, latest response, pending questions, approvals, errors and applied mode/features. Tracks existing IDs in this Pi session too. |
| `send_thread_message` | `threadId`, `message` | Direct authenticated steering/reply; acknowledgement is acceptance, not completion. |
| `wait_for_threads` | `threads` (1–10 IDs), optional `timeout_seconds` (default 300, max 600) | Awaits live events until **all** settle, or returns current states on timeout. No polling interval. |
| `stop_tracking_thread` | `threadId` | Stops the local observer and saves that choice across reload. Does not cancel, archive or change the remote thread. A later status read or message resumes tracking. |

Modes follow the account's Amp dial. For Claude Code, use `mode: "external-agent:claude-code"` and, for example, `features: ["model:claude-opus-5-5", "effort:high"]`. Those spellings were verified against Amp on 13 October 2026. Unknown feature/model strings can be silently ignored by Amp: compare returned features and the actual model in `amp threads export <id>`; this extension does not assert model selection from requested strings.

Owned observers wake Pi on questions, errors, approval gates and settled work, even when Pi is idle. If Pi is running, updates queue as follow-ups. No wait tool call or new user message is needed. Updates show readable text rather than the serialized connection snapshot; full status remains in message details and `get_thread_status`. Transient transport disconnects update the footer status without starting model turns, and the observer reconnects in the background. Authorization and protocol failures still wake Pi once per failure and message identity, including across reconnects and reload. `idle` means stopped, **not verified success**. Read the response and check the task's evidence. Normal questions can be answered by `send_thread_message`; `requiresHuman` questions and tool approvals must be resolved by the user in Amp. This tool never approves or bypasses them.

Cancellation releases a local wait/launch operation, not remote work. A cancelled launch or uncertain send may already have reached Amp; check before retrying. Pi shutdown/reload closes local sockets only. Tracked IDs and notification identities resume from the active session branch; no credentials or actor tokens enter that metadata. Keep Pi running for live notifications. After verifying and handling a result, call `stop_tracking_thread` to release the local observer. Archive a remote orb separately when no longer needed.

## Protocol boundary

This is an opt-in integration with Amp's **currently observed, undocumented** actor protocol, not exact native-tool schema parity. `lib/amp-orbs/connection.ts` holds the transport boundary and `lib/amp-orbs/protocol.ts` the event protocol. The connection reads the active CLI account (server + user + login session), or `AMP_API_KEY`, and requests normal read/write authorization from `/api/thread-actors`. On HTTP 401 it lets `amp usage` refresh the CLI's own credentials once, then rereads the active credential. It never reads/copies refresh tokens or tries a different account. HTTP 403 is not bypassed. `AMP_URL` and `XDG_DATA_HOME` follow the CLI environment.

The public page's `threadActorConfig.baseURL` string is parsed as data only. No downloaded JavaScript executes. The observer opens Node's built-in WebSocket to that Rivet gateway with the same `threadActor` key route the Rivet client used (checked against Amp on 14 October 2026); short-lived tokens and endpoint credentials remain in memory. Discovery changes fail clearly. Reconnection obtains a fresh token and synchronizes a snapshot plus resume acknowledgement before reporting live state. There is no `amp top`, intermediary Amp model, background wait process, periodic status sweep, or executor attachment.

Implementation defaults chosen here: network/synchronization/send acknowledgement timeouts are 30 seconds, launch timeout 120 seconds, failed transport reconnect backoff 1–30 seconds, latest response text tail 12,000 characters. These are local resource/display choices, not Amp limits. Full transcripts remain available through `amp threads export` or the Amp UI.

## Validation

- `node --test tests/test_amp_orbs.mjs`
- `npx jiti tests/test_amp_orbs_extension.mjs`
- `node tests/test_features.mjs`
- `npm run typecheck`
- Explicit live test (uses account/model quota): `npx jiti tests/amp_orbs_acceptance.mjs /absolute/scratch/evidence-dir`. It discovers ambient Pi tools/extensions, runs `openai-codex/gpt-6.1-sol` with medium thinking, tests an idle background wake and all five tools, independently exports the Amp thread, then archives only its scratch orb. No personal settings are changed.

Unit fixtures cover errors, approvals/human gates, 401 refresh, reconnection, reply races, cancellation, quiet transport changes, readable updates and persisted unwatch. The live test checks that a real reconnect does not add an update or model turn and that the model can stop the local observer. Live testing does not force credential expiry or exercise a real human-only approval gate; those remain regression-fixture coverage rather than live claims.
