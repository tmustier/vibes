# Fast mode

Vibes owns `/fast`. The setting persists across sessions and applies to supported models:

| Command | Requested processing |
| --- | --- |
| `/fast` | Toggle Fast on or off; also turns Ultrafast off |
| `/fast on` | OpenAI Priority, or the existing Claude Opus 4.6 Fast beta |
| `/fast off` | Stop applying the speed patch |
| `/fast ultrafast` | Astra or GPT-6.1 Sol Ultrafast |
| `/fast status` | Show the selected mode, compaction speed, model, request patches and last reported service tier |
| `/fast compaction off\|fast\|ultrafast` | Speed for compaction summaries; Fast until you set one |
| `/fast compaction default` | Back to the default compaction speed |

Compaction has its own speed so that summaries can run fast while turns stay standard. Compaction never runs slower than the turns: with `/fast ultrafast` and compaction at Fast, summaries run at Ultrafast. If the model lacks the requested speed, summaries use the fastest it has, so Ultrafast compaction on a model with only Fast runs at Fast. `/fast status` shows the setting, whether it is the default, and whether fast mode raised it.

Ultrafast sends `service_tier: "ultrafast"` for `gpt-6-astra` and `gpt-6.1-sol` on both OpenAI Responses transports. It leaves other models unchanged. The footer shows `ultrafast n/a` when the selected model does not support the patch. Switching back to Astra or GPT-6.1 Sol applies the saved selection again.

## How the speed reaches requests

Fast mode layers a `streamSimple` function onto the `openai-codex`, `openai` and `anthropic` providers with `pi.registerProvider`. Pi merges that layer with the built-in provider and any other extension's registration (such as pi-oauth's Anthropic `baseUrl`), so logins, models and endpoints stay as they were. Every request Pi sends through those providers passes through the layer, which hands it to pi-ai unchanged apart from the speed fields. That includes compaction summaries and overflow recovery, which Pi sends outside the chat loop where `before_provider_request` hooks never run. The layer runs after those hooks, so another extension's hook cannot overwrite the tier.

Pi brackets each compaction with `session_before_compact` and `session_compact` or `session_compact_failed`. Requests inside that window use the compaction speed. Compaction keeps the active model; a compaction extension that summarises with another model gets the fastest speed that model has, up to the requested one, or none.

The Anthropic `fast-mode-2026-02-01` beta header still goes through `before_provider_headers`, which Pi runs for every request. `/reload` keeps the previous layer registered until the reloaded extension registers over it; the old layer stops applying speeds at `session_shutdown`.

## Speed labels in sessions

On supported models, assistant messages get a `vibes.speed` diagnostic with `details.speed` set to `standard`, `fast` or `ultrafast`. Compactions get a `vibes.speed` custom entry containing `targetId` (the compaction entry's ID), provider, model and speed.

```bash
jq -c 'select(.type == "message" and .message.role == "assistant") | {model: .message.model, speed: ([.message.diagnostics[]? | select(.type == "vibes.speed") | .details.speed][0] // "unlabelled"), cost: .message.usage.cost.total}' session.jsonl
jq -c 'select(.type == "custom" and .customType == "vibes.speed") | .data' session.jsonl
```

Labels record the speed Vibes applied. The backend can still report `default`, and labels do not reflect tiers set by other extensions. Older responses, unsupported models, requests outside the layer and sessions where another extension owns `/fast` stay unlabelled. Pi's cost estimates are unchanged; apply the speed's rate for your billing route.

## HUD controls

With the updated `pi-session-hud` loaded, the input border shows `standard`, `↯ fast` or `↯ ultrafast`. In fullscreen mode, click that label to cycle Standard → Fast → Ultrafast → Standard on Astra and GPT-6.1 Sol. On other supported models, it cycles Standard → Fast → Standard. `/fast` itself keeps its existing on/off behaviour. Hover the label to open Speed, then click a row to select a specific mode. Clicking the label while the hover menu is open still cycles—it does not pin the menu. The popup offers Standard and Fast for supported models, adding Ultrafast for Astra and GPT-6.1 Sol. It uses the same saved setting as `/fast`.

If a saved mode is unavailable for the current model, the border shows `ultrafast n/a` (or `fast n/a`) without the acceleration glyph. No row is checked until you choose a supported mode. Closing the popup leaves the saved preference intact; switching back to a supported model restores it. Picking Standard explicitly turns acceleration off. Models with no accelerated mode have no speed popup.

The backend's reported tier stays in the footer when it differs from the requested tier. Older HUD versions continue to show the extension status, but do not provide this popup.

## Access and billing

For subscription usage, use your working OpenAI provider. The home defaults use `/login openai-codex`; the optional `/login openai` → Sign in with ChatGPT route also supports the patch. OpenAI lists Pro $500 and eligible Enterprise and Edu plans for Ultrafast. Workspace permissions and processing residency also affect access. Other self-serve plans do not have access at launch, even with purchased credits.

Ultrafast on Astra and GPT-6.1 Sol consumes included subscription usage at 8 times the Standard rate. Purchased credits use 6 times the Standard rate. API keys use separate API pricing. Check [OpenAI's Codex speed guide](https://developers.openai.com/codex/agent-configuration/speed) and [API Ultrafast guide](https://developers.openai.com/api/docs/guides/ultrafast-mode) for current terms.

The command and footer show the selected mode and the service tier reported by the last completed response. That field may remain `default` even when Ultrafast measurably increases throughput. It is not reliable proof of a downgrade. Pi 0.99.1's cost estimate does not include Ultrafast pricing. Pi's Codex subscription transport supports persistent WebSockets; this extension does not replace the transport.

Pi Codex Conversion also has a Fast mode setting. Keep it off when using `/fast ultrafast`: both would set a tier, and Vibes fast mode now applies last, so the two settings would disagree without changing the result. Its prewarm requests use its own settings too.

## Local verification

On 30 September 2026, Pi 0.99.1 ran 4 interleaved Standard and Ultrafast samples through `openai/gpt-6-astra` with medium thinking. Each prompt requested the integers 1 to 600 as a space-separated sequence. All outputs matched and reported 1,203 output tokens, with no reasoning tokens or tool calls.

| Requested mode | Text-stream tok/s | Full-request tok/s |
| --- | --- | --- |
| Standard, first sample | 33.2 | 30.4 |
| Ultrafast, first sample | 336.5 | 174.0 |
| Standard, second sample | 33.3 | 31.1 |
| Ultrafast, second sample | 431.9 | 214.7 |

Text-stream rates divide provider output tokens by the observed first-to-last text chunk span. Ultrafast arrived in fewer, larger chunks, so those rates can overstate generation speed. Full-request rates include the initial wait. Both measurements show a clear speed increase; all responses still reported `service_tier: "default"`.

A separate Ultrafast tool round trip used `apply_patch` and `exec_command`. The host independently verified the resulting scratch file and removed it afterwards. These local results are evidence for the working `openai` subscription path, not a performance guarantee for every account.

Before GPT-6.1 Sol Ultrafast support was added, a joint fullscreen-terminal run with the updated HUD verified click-to-cycle Standard → Fast → Ultrafast → Standard on Astra, Standard → Fast → Standard on Sol, and selecting Ultrafast through the hover menu. Clicking the label with the hover menu already open advanced the mode and closed it. Switching from Astra to Sol showed `ultrafast n/a` with only Standard and Fast choices; switching back restored Ultrafast. A real Astra prompt used the `write` and `read` tools successfully, with all three requests carrying `service_tier: "ultrafast"`. The host independently checked the scratch file and cleaned up the session. Unit tests also cover stale model selections, reported-tier retention and menu shutdown.

On 8 October 2026, Pi 1.1.0 ran `openai-codex/gpt-6.1-sol` with medium thinking and the Sol-enabled request gate. The prompt asked it to write `SOL_ULTRAFAST_OK` to a scratch file, read it and reply `VERIFIED`. The model called the real `write` and `read` tools successfully; all 3 requests carried `service_tier: "ultrafast"`. The host independently checked the file contents and removed the scratch session. Responses reported `default`, as in the earlier Astra runs. This verifies the request and tool path, not Sol's speed multiplier. Regression tests cover both OpenAI transports, HUD cycling and selection, switching between Sol and Astra, and unsupported models; the API-key transport and fullscreen mouse interactions were not rerun for Sol.

On 14 October 2026, Pi 1.2.0 ran `tests/fast_mode_acceptance.mjs` on `openai-codex/gpt-6.1-sol` with medium thinking, `/fast` at Fast and compaction at Ultrafast, in a private agent folder holding only the login and those settings. The script records every request body sent over the Codex WebSocket or SSE transport. A real turn replied `READY` with `service_tier: "priority"`; `/compact` then sent one summarisation request with `service_tier: "ultrafast"` on the same model, and the compaction entry was persisted. A first run showed one extra `priority` request: the Codex transport re-sends the same body after a connection-limit error, so retries keep their tier. Two further runs showed exactly one request per phase. Unit tests cover the provider layer, the compaction window, a failed compaction closing it, shutdown, the Anthropic header, and the existing command and HUD behaviour. Not rerun live: the `openai` API-key transport and Anthropic fast.

On 14 October 2026, the same script ran with `/fast` off and compaction at its default. The two turn requests (the prompt and the Bash round trip) carried no tier; the one compaction request carried `priority`.

On 16 October 2026, Pi 1.2.0 ran `tests/fast_mode_acceptance.mjs` on `openai-codex/gpt-6.1-sol` with medium thinking three times: `/fast` at Fast with compaction at Ultrafast, `/fast ultrafast`, and `/fast` off with the default compaction speed. Each time the model called the real `bash` tool, and the script compared the request bodies sent over the Codex WebSocket with the saved session file. Every saved response was labelled with its turn's speed (`fast`, `ultrafast` and `standard`), and the compaction entry had one `vibes.speed` entry naming its speed (`ultrafast`, `ultrafast` and `fast`), matching the tiers sent. Not rerun live: the `openai` API-key transport and Anthropic fast.

## Existing settings

Vibes reads the old `fast-mode.json` `enabled` boolean and saves a `mode` field after you change the setting. `enabled: true` becomes Fast, never Ultrafast. `/fast compaction` adds a `compaction` field; without it, compaction uses the default speed, Fast.

A separate `@linioi/pi-fast-mode` install continues to own `/fast`, with a migration notice from Vibes. Remove that package and reload to use this version. See [existing setup migration](existing-setups.md#fast-mode-from-an-older-vibes). Excluding `extensions/fast-mode.ts` still turns the Vibes extension off.
