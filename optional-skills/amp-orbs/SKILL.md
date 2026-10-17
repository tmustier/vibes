---
name: amp-orbs
description: Launch, brief, steer and monitor Amp orbs (remote Amp threads) with Pi tools or the command line. Use when delegating work to an orb instead of a local worker, choosing an orb mode (including Claude Code with Opus), sending an orb a follow-up or a mid-turn steer, or checking what an orb is doing.
---

# Amp orbs

Orbs are Amp threads that run on Amp's machines, not this Mac. Prefer them to local workers when the work runs an app, tests or a browser, so local CPU stays free. Each orb gets its own environment from the repository's `.agents/setup` and `AGENTS.md`.

## Pi tools (preferred)

Enable the optional `amp-orbs` Vibes feature and reload. See [tool setup and protocol boundary](../../docs/amp-orbs.md). Use `create_thread` with the literal brief, absolute local `cwd`, explicit `mode`, and optional `project`, `title` and `features`. Its returned ID is tracked by this Pi session: questions, errors and settled work wake Pi without polling or a wait call. Use `get_thread_status` to read the live response, `send_thread_message` to steer or answer an ordinary question, and `wait_for_threads` to await all listed threads. No intermediary Amp model is called.

For Claude Code, pass `mode: "external-agent:claude-code"` and `features: ["model:claude-opus-5-5", "effort:high"]`. Unknown feature/model strings may silently be ignored by Amp; verify the applied features and actual model.

## CLI launch (when the tools are not enabled)

```bash
cd <repo>                                     # the orb uses this repository
# Write the brief to a file first and finish writing it before you launch.
# Don't write the file and launch in parallel.
amp -ox "$(cat brief.md)" -m medium --title "<short title>"   # prints the thread URL
```

- `--attach <path>` uploads a local file with the message; repeat it for several files.
- Record the printed thread ID (`T-…`). You need it for everything else.

## Choose a mode

| Work | Mode |
|---|---|
| Well scoped | `-m medium` |
| Larger, still well defined | `-m high` |
| Ambiguous, or needs visual or product taste | Claude Code with Opus 5.5 (below) |

Don't use `ultra` unless the user asks for it.

The model behind each mode follows the user's dial, not Amp's defaults. Amp's default `medium` runs Opus 5.5, but an account with the ChatGPT Only preset runs `medium` on GPT-6.1 Sol and `high` on GPT-6 Astra. Check with `amp threads export <id>`: each assistant message's `usage.model` names the model. Claude Code mode is how to get Opus on the user's Claude plan.

A thread keeps the mode of its first message. To change mode, start a new thread.

An unknown `-m` value fails with a generic "Unexpected error inside Amp CLI", not "unknown mode". Check spelling first.

## Claude Code with Opus 5.5

- The mode key is `external-agent:claude-code`. It runs Claude Code (the Claude Agent SDK, built into Amp, not a plugin) on the user's linked Claude Pro/Max plan. The orb's own running time still bills to Amp.
- Set the model and effort with `--features` when you launch. Without them it starts on Sonnet:

```bash
amp -ox "$(cat brief.md)" -m external-agent:claude-code \
  --features model:claude-opus-5-5,effort:high --title "<title>"
```

- `amp --help` lists only `fast`, `plaid` and `pro` as known features, but Amp's docs (The Dial, "Choose Model and Effort") document `model:` and `effort:`. Confirmed on 13 October 2026: the thread's `meta.features` recorded both, and the orb reported `claude-opus-5-5`.
- In this mode, Oracle, Librarian and Illustrator are unavailable. Claude Code's plan mode, todo tool and notebook editing are off. Painter still bills to Amp.
- `amp config external-agents show claude-code` shows the agent's options: its post-install script and system-prompt addition. Model and effort aren't stored there.

## Follow up, questions and status

- `send_thread_message` sends directly with `steer: true`, including replies to normal pending questions. Acknowledgement means accepted, not finished.
- `amp threads continue <id> -ox "<message>"` queues a follow-up behind the current turn; it cannot unblock a pending question. Without the Pi tools, answer/steer in the Amp UI.
- `get_thread_status` returns pending questions and approval gates directly. Do not bypass `requiresHuman` or tool approvals: the user resolves those in Amp.
- `wait_for_threads` waits on live events until **all** threads settle (idle after work, question, approval or error), or its timeout returns current states. Cancelling the wait leaves remote work running.
- Idle is not proof of success; verify the response and task evidence. Disconnected or unknown is not idle. Transport disconnects update Pi's footer without waking the model. Avoid `amp top` polling and local model calls to invoke wait/send tools.
- Once you have verified and handled the result, call `stop_tracking_thread` to close this session's local observer. This persists across reload and does not cancel or archive the remote orb. A later status read or message resumes tracking.

To read what an orb last said:

```bash
amp threads export <id> | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(d['title'], d['agentMode'], d['meta']['lastKnownAgentState'].get('state'))
for m in d['messages'][-3:]:
    for c in m['content']:
        if c.get('type')=='text': print(m['role'], ':', c['text'][:300])"
```

- States seen include `streaming`, `running_tools`, `tool_use` and `idle`.
- Exports reach 5 to 10 MB on long threads, so always filter them.
- `amp threads markdown <id>` renders a thread for reading.

## Things that surprise people

- Orbs act with the user's GitHub identity, so they can push and merge. Let them merge their own PRs. They handle rebases and conflicts, and routing every merge through the coordinating agent makes that agent the bottleneck. Say "Do not merge" only when someone else gates merges. Ask orbs to rebase before each merge, because main moves under them.
- A new orb knows nothing of the conversation that launched it. Brief it fully: the goal, the decided design, the files other people are editing right now, acceptance, and the deadline in absolute local time.
- Repositories may have orb-specific run modes. In `garage-demo-may-26`, orbs run the app mailbox-free with `scripts/orb-demo.sh`, and Outlook acceptance needs `--outlook`.
- Orbs don't use local CPU. Local workers that run the app do, so check the load before adding more.
