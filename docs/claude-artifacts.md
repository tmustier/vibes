# Claude artifact tools

On by default. Pi has Claude Code's own artifact tools, so it can publish, read, update, list, pin, open and delete pages on claude.ai, answer their comments and use their shared database, the way Claude Code does.

It needs Claude Code on `PATH`, signed in with `claude auth login` to a Pro, Max, Team or Enterprise account that has artifacts turned on. Without `claude` on `PATH`, the feature adds nothing. Check it with `claude auth status`. To turn it off, set `"claude-artifacts": false` in the `features` map in `~/.pi/agent/vibes.json`, then `/reload`.

## How it works

Pi registers three of Claude Code's tools as its own, and none is declared up front:

| Pi tool | Claude Code tool | What it does |
|---|---|---|
| `mcp__claude_artifacts__Artifact` | `Artifact` | Publish (including multi-file pages, `edits`, runtime `capabilities` and types), read, list, delete, open, pin, unpin and quickstart |
| `mcp__claude_artifacts__ArtifactComments` | `ArtifactComments` | Read, reply to and resolve comment threads, and manage watches |
| `mcp__claude_artifacts__ArtifactData` | `ArtifactData` | Read and write an artifact's shared database |

The system prompt mentions the tools in one line, and the two skills in one line each. When the user asks for an artifact, the model loads the tools with `tool_search`, and they stay loaded for the rest of the conversation. Pi adds them to the conversation rather than to the tool list, so earlier messages stay cached. The feature turns `tool_search` on.

Their descriptions, input schemas and behaviour come from the installed Claude Code, so they change when Claude Code updates. Pi asks `claude mcp serve` (with `CLAUDE_CODE_ARTIFACT=1`, which turns artifacts on in that mode) for the definitions once per installed Claude Code binary and saves them in `~/.pi/agent/cache/claude-artifacts/`, so starting Pi starts no Claude Code. Claude Code lists only `Artifact` until it is signed in; Pi then asks again at each start, in the background, until it gets all three.

The first artifact call in a session starts one `claude mcp serve` in the session's directory. Later calls reuse it, and it stops after 5 minutes without a call or when the session ends. If it exits or fails, the next call starts a new one. A session that never uses artifacts runs no Claude Code. In a five-prompt test session (24 calls), a typical call took about 285 ms, the same as with a server kept running for the whole session. A new process for every call took about 875 ms. Claude Code keeps no record of the conversation between calls, so Pi keeps that record (see below).

Pi adds what `claude mcp serve` does not provide:

- **Guidance skills.** Claude Code's descriptions require the `artifact-design` and `artifact-capabilities` skills, which Claude Code does not serve over MCP. The feature adds Pi skills with those names. `artifact-capabilities` prints the live runtime contract from claude.ai with `lib/claude-artifacts/artifact-api.py`, so it stays current. `artifact-design` is Pi's own page contract and design guidance, based on the published Claude Code rules.
- **Conversation record.** In Claude Code, publishing the same file again updates its artifact, and an update goes through only if the conversation has read or published the version claude.ai serves now. Over MCP, Claude Code remembers neither, so a republish creates a duplicate artifact and every update is refused. Pi records each file the session publishes, each version it publishes or reads, and the hash of each artifact file it publishes, lists or reads. A republish of the same file goes to the same artifact. Before an update, Pi asks claude.ai for the live version and file hashes. It passes `force` only when the live version is the one the session last saw, and, for a multi-file publish, adds to `overwrite_unread` only the published files the session saw unchanged. A newer version or a changed file, such as a save from the page or another session's publish, is still refused. Claude Code then reads the live version into the refusal and counts it as viewed, so the model merges without another read. Over MCP it sometimes only asks for a read, so Pi runs Claude Code's own `read` and adds the result. When Claude Code saves a large page to a file instead, it counts once every line is read; Pi counts the lines the model reads with Pi's read tool. As in Claude Code, resending exactly the refused content is refused once more, and changed supporting files are named for the model to read. Claude Code can show a line diff for a large page; Pi adds none of its own. The record lasts until the session ends or reloads.
- **Delete confirmation.** Claude Code deletes only after its own terminal confirmation, so its delete always refuses over MCP. Pi asks "Permanently delete this Claude artifact?" instead. On Delete, Pi deletes the artifact through the same claude.ai API, checks it is gone, and returns that result in place of the refusal. Without an interactive UI (print mode, background workers) Pi refuses the delete, and the user can delete it from the artifact's menu on claude.ai.
- **Opening an artifact.** Over MCP, Claude Code reports `opened` without opening anything. After an `open`, Pi opens the link in the default browser, or tells the model to give the user the link when the session has no screen.
- **TLS.** Some shells start Pi with `NODE_OPTIONS=--use-openssl-ca`, which stops Claude Code reaching claude.ai. Pi removes only that option for the Claude Code process.

## Differences from Claude Code

- Claude Code asks before some publishes, such as the first publish that declares runtime capabilities or a change to a public artifact. `claude mcp serve` does not ask, so in Pi these publish straight away, as they do in Claude Code's auto and bypass modes. Deletes still need confirmation.
- `claude mcp serve` cannot see claude.ai connectors, so it cannot check the connector tool names a page declares. It publishes with a warning that the connector was not observed. The `artifact-capabilities` skill explains how to check the names.
- Tracking a large live page saved to disk requires Pi's native `read` tool. Shell reads from a tool adapter do not count towards viewing that version. Use a configuration that retains Pi's native file tools for this workflow; for pi-codex-conversion, its Voice only mode retains them.
- Watches and comments sent to Claude do not wake a Pi session. Read comments with `ArtifactComments` when the user asks.
- Publishing does not open the browser, unlike Claude Code's first publish in a session. Pi opens an artifact only for an `open` call.
- Pi's update check and the publish are two requests, so a version saved in the moment between them can be overwritten. Claude Code makes the same check inside one call.
- Claude Code's interactive and Agent SDK sessions follow new versions of their artifacts live, but a new version starts no turn and sends no notification there either, so updates behave the same. Their comments sent to Claude do reach the session; in Pi they do not.
- Claude Code declares `Artifact` up front and loads `ArtifactComments` and `ArtifactData` when needed. Pi loads all three when needed, because declaring `Artifact` costs about 15,000 tokens on every request (measured with GPT-6.1-sol), while loading it costs one `tool_search` call.

## Validation

- `npx jiti tests/test_claude_artifacts.mjs`
- `node tests/test_features.mjs` (through `npx jiti`)
- `npm run typecheck`
- The live test expects Pi's native file tools. If pi-codex-conversion replaces them, select Voice only mode through `/codex` in the test configuration first. Keep personal settings unchanged when using a scratch configuration.
- Explicit live test (uses the Claude account and model quota): `npx jiti tests/claude_artifacts_acceptance.mjs /absolute/scratch/evidence-dir`. It runs `openai-codex/gpt-6.1-sol` with medium thinking, lets the model use the real tools to publish, redeploy the same file, update a multi-file page, read, write and read the shared database, read comments, merge after another writer's change (a small page and one over 50,000 characters) and attempt deletes, and checks each result through claude.ai independently. The test answers Pi's delete question Keep, then Delete, and then checks the artifact is gone. It deletes any scratch artifact it leaves.
