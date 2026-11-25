# Realtime voice

Vibes bundles [GipPity Control](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-gippity-control) for realtime voice (`extensions/realtime-voice.ts`). Ctrl+Alt+Space starts a call and `/gippity` changes its settings, which live in `~/.pi/agent/pi-gippity-control.json`.

## How what you say reaches Pi

The default voice model is Codex Live (`gpt-live-1.1-codex`), through your `openai-codex` login. You talk to a separate voice model, not to Pi. It answers you itself and hands a task to Pi only when it decides there is one. Its handoff text is often just your last sentence, so GipPity gives a task delegation model the conversation since the previous handoff and asks it to rewrite that into one self-contained request.

Pi receives only that rewrite. GipPity stopped sending the raw transcript with Codex Live handoffs on 30 October 2026. Its author's reasons, from his Discord: a transcript dumped into Pi repeats things Pi already did while you were chatting, so it can redo work, and small talk in it can derail Pi. The GPT-Realtime voice models (API key) still send the transcript alongside the task. On Codex Live, if the rewrite leaves something out, Pi never sees it.

## Why Vibes uses a stronger task delegation model

GipPity's default task delegation model is `openai-codex/gpt-6-luna` at `low` reasoning. On 19 November 2026 a call lost about two minutes of spoken background: after the user had explained the situation at length, a short, vague request reached Pi as a one-line task with none of that background.

We replayed that call through each package's own transcript tracker and rewrite function, using Pi's model registry and a real `openai-codex` login, and counted how often the background reached Pi:

| Package | Task delegation model | Background kept |
|---|---|---|
| Codex Conversion 5.0.1 (used on the day) | `gpt-6-luna` at `low` | 5 of 13 |
| GipPity 0.0.34 | `gpt-6-luna` at `low` | 10 of 13 |
| GipPity 0.0.34 | `gpt-6.1-sol` at `medium` | 13 of 13 |

Every failure dropped the background entirely; none kept part of it. Sol also kept more of the situation, such as what the conversation was for and what was still open. It takes about 4 to 8 seconds per handoff, a second or two more than Luna.

Thomas chose `openai-codex/gpt-6.1-sol` at `medium` on 25 November 2026. `pi-gippity-control.template.json` sets it, and `vibes update` applies it (`scripts/sync-settings.mjs`), as do `/onboard` and the managed updater. A different model or reasoning level you choose stays yours. `/gippity` changes the reasoning level; to change the model, edit `voice.taskDelegationModel` in `~/.pi/agent/pi-gippity-control.json`.

Revisit this choice if GipPity changes how it rewrites handoffs, changes its default model, or adds an option to send the transcript with Codex Live handoffs.
