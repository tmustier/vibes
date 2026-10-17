# Moving an existing Pi setup onto Vibes

For the agent running `/onboard` on a Mac that already has Pi, or fixing a setup after an update. A long-lived setup usually has copies, links and jobs from older Vibes versions or from the user's own experiments. Each section below is a problem seen on a real laptop: how it shows up, and what to do.

Two rules apply throughout:

- Vibes owns the resources it manages. When two copies do the same job, migrate to the Vibes version even if the contents differ; `/onboard` and the automatic startup repair are authorised to do this without asking which copy to keep. Keep unrelated resources, explicit opt-outs and forks the user has explicitly chosen to maintain. An installed or differing copy, or extra instructions in it, is not that choice.
- Remove recoverably. Move loose copies to `~/.Trash`, remove a symlink without touching its target, and back up settings before editing. For a mixed package, exclude only the duplicate resource in the personal package and keep its other resources and source files. Repoint commands linked into an old skill before moving it. Keep useful personal instructions in the user's or project's own context rather than in a second active copy, and report a behaviour difference you could not reconcile instead of dropping it.

### A differing skill in a personal starter kit

If a personal starter kit and Vibes both provide `ask-granola`, migrate the duplicate recoverably: back up settings, add `!skills/ask-granola/SKILL.md` to the kit's skill filters (keeping its other skills and existing exclusions), leave the kit's source unchanged, and check in `vibes inventory` that `ask-granola` now loads from Vibes.

## One personal Vibes feature file

Use `~/.pi/agent/vibes.json` for ordinary Vibes feature choices:

```json
{ "features": { "surf": false, "cachemire": true, "meantime": true } }
```

Names match `extensions/<name>.ts`; `vibes features` lists choices and defaults. Amp orbs, Cachemire and Meantime default off. Vibes controls loading, not extension-specific flags: Meantime also needs `"enabled": true` in `~/.pi/agent/pi-meantime.json` (project config can override it). Opt-ins use the installed Vibes copy.

For an existing personal setup:

1. Update the installed Vibes package. Keep the same package entry, not a second checkout alongside it.
2. Run `vibes features migrate` to preview moving exact `!extensions/<name>.ts` or `-extensions/<name>.ts` opt-outs from its personal package entry into `features.<name>: false`. For a branch, local path or alternate source spelling, use its exact settings source: `vibes features migrate --source 'git:github.com/tmustier/vibes@my-branch'`.
3. Review the preview. Close Pi, then rerun the same command with `--apply`. It backs up both files under `~/.pi/agent/vibes-feature-backup-<time>/` and writes feature choices before removing the corresponding native filters. Existing feature choices are preserved; a conflicting `true` stops migration without writing. To restore, copy both backups back; if `vibes.json.absent` is present, remove the newly created `vibes.json` instead.
4. Review retained filters separately: globs, positive lists, `[]`, unknown paths and non-extension filters are unchanged. Native Pi exclusions still win over feature choices, including in projects.
5. Keep unrelated extras and deliberate forks. Matching separate copies still take precedence; compare them before removing redundant selections.
6. Add any desired opt-ins to `vibes.json`, then restart Pi and follow [checking your work](#checking-your-work). `/cache` and `/pace` should appear only when enabled, and Surf's skill should disappear when `surf` is false.

### Previously selected Cachemire/Meantime package resources

Some setups have a separate package entry selecting `extensions/pi-cachemire` and/or `extensions/pi-meantime` from `pine-of-glass`, including a local path inside the installed Vibes `node_modules`. The automatic migration leaves that entry unchanged. Review it explicitly:

1. Inspect the selected resources and Meantime's global/project flag. A selected resource alone does not prove Meantime was active.
2. Back up settings, remove only redundant observer selections, and put the user's desired choices in `vibes.json`. Keep other resources, forks and extension preferences.
3. Restart Pi, verify `/cache` and `/pace` as appropriate, and follow [checking your work](#checking-your-work).

Explicit `vibes check` and `vibes inventory` requests run their infrastructure helpers even if those features are false. Native exclusions can still prevent loading them.

Migration is explicit and personal only, never part of `vibes update`. `PI_CODING_AGENT_DIR` selects an isolated agent directory for previews/tests, following Pi's convention.

## Pi warns "Your Vibes setup is out of date"

```text
Warning: Your Vibes setup is out of date: your settings list the Vibes features from an older template, so you're missing the current ones. Run /onboard to update it.
```

Every Vibes template before the current one listed which Vibes files to load (`"extensions": ["extensions/tips.ts", …]`, `"skills": [...]`). Such a setup keeps loading only those files, so it misses everything Vibes has added since. Replace the entry with the plain source, `"git:github.com/tmustier/vibes"`, keeping only exclusions (`!…`) the user added, then work through the rest of this guide: the full Vibes set now loads, including defaults that may duplicate the user's own packages.

Older templates also installed `git:github.com/tmustier/pi-symphony`. Its install now fails (`sh: lefthook: command not found`), and `pi update` stops at the first failure, so the packages after it, Vibes included, never update. Remove it.

## Pi won't start: "Tool … conflicts with …"

```text
Error: Failed to load extension ".../tmustier/vibes/extensions/papercut.ts": Tool "papercut" conflicts with ~/.pi/agent/extensions/papercut.ts
```

Two extensions registered the same tool, so Pi exits. The usual cause is a copy of a Vibes extension in `~/.pi/agent/extensions/`, left by the old setup, which copied files there. Compare it with `$VIBES/extensions/` and apply the rules above. Move the redundant copy to the Trash. Exclude Vibes only for a deliberately maintained alternative (see [turning off one Vibes resource](#turning-off-one-vibes-resource)).

Also look through `~/.pi/agent/extensions/`, `skills/`, `prompts/` and `agents/` for other copies or links of Vibes files. `git -C $VIBES log --name-only --format= -- extensions prompts skills | sort -u` lists every file Vibes has shipped. Several are links into a personal repo (for example `~/projects/pi-setup`); remove the link, never the repo file.

## Skill, prompt or theme conflicts

```text
[Skill conflicts]
  "visual-verify" collision:
    ✓ auto (user) ~/.pi/agent/skills/visual-verify/SKILL.md
    ✗ ~/.pi/agent/git/github.com/tmustier/vibes/skills/visual-verify/SKILL.md (skipped)
```

Pi still starts, keeps the user's copy and warns on every start. The causes:

- **A loose copy or link of a Vibes skill or prompt** in `~/.pi/agent/skills/`, `~/.pi/agent/prompts/` or a project `.pi/skills/` (including `~/.pi/skills/` when working from home). If it does the same job, use Vibes: remove the link or move the old copy to the Trash. A Git checkout can be an older copy even if its files differ in personal paths; check for commands linked into it and repoint them to Vibes first. Back up differing edits, then migrate to Vibes; keep a separate fork active only when the user has explicitly chosen it.
- **The user's own install of a package Vibes bundles** (for example `git:github.com/tmustier/pi-extensions` or `pi-codex-goal`). The bundled copy steps aside for each kind of resource (extensions, skills, prompts) that the user's copy loads, after its filters: a copy installed with `"skills": []` leaves the bundled skills in place. It counts the user's global settings, and project settings in a folder Pi trusts, including a project package Pi hasn't installed yet; it matches by the installed package's name. Until Pi has decided whether to trust a folder, the bundled copy steps aside for that folder's copy; if Pi then doesn't trust the folder, it says so, and `/reload` restores the bundled copy. If a collision still names a file under `$VIBES/node_modules/`, the user's copy isn't installed through settings (for example a loose link): handle it like a duplicate command below.

## Duplicate commands (`/name:2`)

The same extension loads twice, but not through a package entry in `settings.json`, so the bundled copy can't tell. For example, a local checkout linked into `~/.pi/agent/extensions/` (`pi-contextimate` → `~/projects/pine-of-glass/...`). If the user has explicitly chosen to maintain that fork, keep it and exclude the Vibes wrapper. Otherwise remove the link (the checkout keeps any edits) so Vibes owns the resource.

## Local `pi-browser` conflicts with Vibes' `browser` tool

A locally installed `~/.pi/agent/extensions/pi-browser/` registers the same `browser` tool and `/browser-import`, `/browser-status`, and `/browser-reset` commands. Compare its source with Vibes' `packages/pi-browser/` first. If it is the same implementation, move the local extension directory to the Trash; leave `~/.pi/agent/browser/chrome-profile` untouched so its imported cookies remain available. If it has unique edits, back them up and migrate to Vibes anyway; keep the local variant, with `extensions/browser.ts` excluded, only if the user has explicitly chosen to maintain it.

## Shortcut conflicts

```text
Extension shortcut conflict: 'ctrl+shift+enter' registered by both A and B. Using B.
```

Two copies of an extension, often one global and one project-local (a repo's `.pi/extensions/`). It shows only inside that repo. Keep one copy.

Vibes ships `Ctrl+Shift+Enter` (send “continue”) through `extensions/continue-shortcut.ts`, so it works in every folder. If an older global `~/.pi/agent/extensions/continue-shortcut.ts` duplicates it, compare the files and remove the redundant copy recoverably. If it is a symlink, remove only the link, not its target. The old repo-local `.pi/extensions/continue-shortcut.ts` is no longer needed.

## Separate entries for packages Vibes bundles

The bundled copy steps aside for matching resources a separately installed package loads, so nothing registers twice. That is not an opt-out: at interactive startup or `/reload`, Pi warns and starts an agent turn that migrates those duplicates to Vibes (a failed update is handed to the agent the same way). Hidden `vibes check` runs, print and RPC sessions start no such turn, and only one session repairs at a time.

Back up settings and remove the redundant package entry, or exclude only its overlapping resources when the package also supplies unrelated ones; its source stays. Do not exclude Vibes to clear the warning. Then confirm in `vibes inventory` that the Vibes resource loads: a clean start alone does not show which copy won.

Computer Use and Session HUD are rolling defaults inside Vibes: remove redundant separate entries after comparing them, then run `vibes update` to fetch their published npm `latest`. All other bundled versions and Pi remain pinned. The home updater refreshes these packages explicitly; it does not install a nightly or hotfix job.

### Pinet declares the same npm name as pi-extensions

`gugu91/pinet` currently names its root package `pi-extensions`, but a Slack-only installation loads `slack-bridge/dist/index.js`. That is not a personal copy of Vibes' `/code`, `/paste`, `/usage` or `/readfiles` modules: their wrappers match their explicit entry paths, not just the npm name. Keep the Slack package and its resource filters; do not remove it or exclude these Vibes wrappers merely because the names match. Verify the actual loaded resources with `vibes check` and the command list. A real personal copy loading the matching module still takes precedence.

### Pinet update fails to build model-aware compaction

On Pi 1.0.3, updating `git:github.com/gugu91/pinet` to `78b24b7` failed with `Cannot find module '@earendil-works/pi-ai/compat'`. Its Git install builds every workspace, including model-aware compaction, even for a Slack-only resource selection. The production install omits the workspace's development dependency on Pi 0.87.1, which supplies that compatibility export.

To repair the installed checkout without changing its source or resource filters, run `npm install --include=dev --legacy-peer-deps` and `npm run build:packages` inside the Pinet directory shown by `pi list`. Then run `vibes check`. This is a local workaround: another package update can omit those dependencies again. The upstream build needs a fix before production-only Git installs work reliably. Do not remove Pinet or change its loaded resources to hide the failure.

`pi-mcp-adapter` is no longer bundled: migrate its servers to native MCP below, then remove its separate package entry.

## Idle parking stopped working

Parking needs both the Vibes extension and `scripts/pi-park`, which keeps the terminal open after Pi exits and restarts the saved session on a keypress. A `~/bin/pi` symlink can stop being used when a Node upgrade puts its own `pi` earlier on PATH.

Run `whence -va pi` in an interactive zsh shell. If you opted into parking, add the [README's shell alias](../README.md#idle-parking) to `~/.zshrc`:

```zsh
alias pi="$HOME/projects/vibes/scripts/pi-park"
```

Open a new terminal and run `pi --help`. It should list `--park-after`. Restart existing Pi sessions through the alias; `/reload` cannot add the missing launcher to a running process. `/park` now explains the launcher requirement when Pi was started directly.

Parking remains opt-in. Do not replace the npm `pi` executable or change PATH ordering for other programs. Slack and Pinet connections still prevent automatic parking.

## Fast mode from an older Vibes

Vibes now owns `extensions/fast-mode.ts`, including `/fast ultrafast`. A separate `@linioi/pi-fast-mode` install still takes precedence: Vibes leaves `/fast` to it and reports how to migrate. Unless the user has explicitly opted out, back up settings and remove the separate entry with `pi remove npm:@linioi/pi-fast-mode` (or its actual source from `pi list`) and reload. Check trusted projects for their own copies too. Keep `~/.pi/agent/fast-mode.json`: Vibes reads the old `enabled` preference. Existing exclusions of `extensions/fast-mode.ts` still work.

## Pi Dial from an older Vibes

Vibes used to bundle Pi Dial for subagents; it now bundles pi-subagents. A personal `@tmustier/pi-dial` entry in `settings.json` still loads Pi Dial alongside it, with its own `oracle` and `Task` tools. Remove the entry unless the user wants Pi Dial on purpose. Model switching moves to ⌘P, and ⇧Tab raises the thinking level. `/wut` is now part of Vibes: move any personal copy in `~/.pi/agent/extensions/` to the Trash, or Pi lists `/wut` twice.

## Oracle fails with "Agent is already processing"

A forked Oracle copies the parent's active goal, and the goal extension continues it during child startup, before the Oracle's task arrives. Vibes now starts Oracle fresh (`defaultContext: "fresh"` in `settings.template.json`) and gives it the parent session's JSONL path to read when it needs history.

Run `vibes update`, check any personal `subagents` settings that settings sync kept, and reload. An explicit `context: "fork"` can still hit the problem.

## OpenAI login and model references after Pi 0.99.1

Pi 0.99.1 added **Sign in with ChatGPT** to provider `openai`, using the OpenAI Responses API. This is a different OAuth flow, not a rename of `openai-codex` or its stored credential. [OpenAI’s DevDay announcement](https://learn.chatgpt.com/docs/whats-new/devday-2026#sign-in-with-chatgpt) describes new subscription sharing for eligible Plus/Pro users, not Business seats.

Depending on account eligibility, `/login openai` can fail with `3p_delegated_access_policy_denied` even while `openai-codex` works. Do not direct a working Codex user to the new login just because Pi labels Codex legacy.

1. Preserve the working provider, credentials and personal settings. The home defaults use `/login openai-codex`, `openai-codex/gpt-6.1-sol` and `openai-codex/gpt-6-astra`.
2. `vibes update` keeps the selected OpenAI route while updating template-managed models and subagent references. It also preserves working `openai` setups; it does not infer eligibility from a saved credential or silently change billing paths.
3. If an earlier migration selected `openai` without a successful login, back up settings and explicitly restore the working `openai-codex` references in the default, model list, per-model settings and subagent routing. Leave stored credentials alone. Select Codex with `/model` in resumed sessions too.
4. An eligible user can explicitly choose the new `openai` route. Complete its own login, run a real prompt with tool calls and independently verify the result before changing defaults and launchers. Never copy credentials between providers or remove the working route as part of this change.

`/wut` previously preferred `openai/gpt-6-luna`, so it could fail authentication even when the main agent worked through Codex. It now tries `openai-codex/gpt-6-luna` first and retries through `openai/gpt-6-luna` on failure, using each provider's own credentials. Missing observer authentication is skipped; if neither observer is configured, it keeps the session-model fallback. Cancellation never starts a fallback request. Update Vibes and reload Pi to load the fix.

### Configure the wut model

To choose another model or fallback order, create `~/.pi/agent/wut.json`:

```json
{
  "models": ["openai-codex/gpt-6-luna", "openai/gpt-6-luna"]
}
```

The list runs in order for both `/wut` and its watchdog. Each entry is `provider/model-id`. Use one entry to select a model without a fallback, or several to retry after provider errors. Missing models and providers without configured authentication are skipped. Cancelling a request stops the entire chain.

An explicit list replaces the defaults and does not add the session model. Without the file, the default is the Luna chain shown above, with the session model used only if neither default has configured authentication. Changes apply on the next request, without a reload. `PI_CODING_AGENT_DIR` also applies to this file.

If an earlier fix exists only on a local branch, your installed Vibes copy will still use the old provider. Confirm that the fix was merged and that the installed `extensions/wut.ts` contains `observerModels`, then update and reload.

Follow the startup checks below. A login, model-picker entry or restored session label is not proof of a working request.

## Sol still shows a 272K context window

Pi 1.1.0's catalogue still lists `openai-codex/gpt-6.1-sol` at 272K after Codex raised its default to 500K. Vibes syncs `models.template.json` into the matching fields in personal `models.json`, preserving unrelated provider settings and deliberate model overrides. Restart Pi after updating and check `pi --list-models 'gpt-6.1-sol'` for 500K on the Codex route.

The Sol compaction override uses `reserveTokens: 50000`: Pi compacts above `500000 - 50000 = 450000` projected context tokens, matching Codex's 90% fallback budget. Pi estimates the canonical projected context, so provider-reported input usage need not trigger at precisely that count. This is not an ordinary-response output limit. It also sets Pi's history-summary output ceiling to 40K (80% of the reserve); recent retained history stays at Pi's default 20K. This matches the context and fallback trigger, not Codex's summarization implementation. Subscription billing remains server-controlled; Pi's displayed long-context cost estimate may be stale.

If settings sync reports that it kept a personal `compaction` object, inspect it and merge the Sol override explicitly if wanted. Do not replace the whole object or discard other model preferences.

## Pi 1.0 migration on an existing laptop

Pi 1.0 stores MCP OAuth credentials per server name and URL. The first connection moves credentials stored under a URL alone to that server, after which Pi 0.99.2 may report the server as needing sign-in: do not downgrade without restoring an earlier credential backup. When several server names share one URL, check each account separately.

For an existing setup crossing this version boundary, save `pi mcp list --json` before upgrading, then compare every previously connected server after `vibes check`. The retained migration checklist in `docs/pi-1-migration-agent.md` can guide an explicitly requested verification. The home updater does not launch this migration agent automatically. Verify a real read-only MCP call and background subagent execution; connection status alone is not proof.

If sign-in needs user approval, report it and complete it with the user. Do not remove a working account or personal package to make the check pass. Open a fresh Pi session to check the interactive TUI and session resume.

The bundled pi-subagents pin is newer than 0.74.0 and includes the upstream fix for Pi 1.0's removed `pi-agent-core/node` export. 0.74.0 also replaced `workflowScript` and `workflowScriptPath` with `workflow`; migrate personal workflow scripts that use them. Ordinary worker and oracle calls are unchanged.

## Native MCP after Pi 0.99.0

Pi now connects MCP servers itself. The old `pi-mcp-adapter` reads `~/.pi/agent/mcp-adapter.json`; native Pi reads `~/.pi/agent/mcp.json` (or a trusted project's `.pi/mcp.json`). Merely upgrading Pi does not move any servers. Leaving the adapter installed may also duplicate the `/mcp` command. Vibes retains its adapter-specific per-send approval during this transition, but an adapter session does not gain native codemode access to the old server entries. [Pi's MCP reference](https://github.com/earendil-works/pi/blob/v0.99.0/packages/coding-agent/docs/mcp.md) documents native config, supported fields and OAuth.

1. Back up `mcp-adapter.json`, `mcp.json` if present, and `settings.json`. Inspect *every* adapter server and any adapter imports, project overrides or dynamically registered servers before changing anything. Do not paste credentials into logs, issues or telemetry.
2. Add each server to native `mcp.json` without replacing existing native servers. Simple stdio entries use `command`, `args` and optionally `cwd`/`env`; streamable HTTP entries use `url`, `headers` and optionally `oauth`. Legacy SSE endpoints are unsupported. Adapt authentication rather than copying adapter-specific `auth`, `bearerToken`, `bearerTokenStore` or `oauth.redirectUri` fields: native OAuth uses `oauth.clientId` and `oauth.callbackUrl` when needed; a static token should be referenced through an environment variable or a command in `headers`, not copied in plaintext. Adapter-stored OAuth and bearer tokens do not transfer automatically; sign in again with `pi mcp login <server>` or arrange the supported header credential. Keep the old file until verification passes.
3. Review adapter-only `lifecycle`, `directTools`, `approveTools`, `requestTimeoutMs` and `debug` settings. Native `toolExposure` can make named tools `direct`, native `timeout` is in **seconds**, and Vibes' `send-approval.ts` covers Superhuman `send_draft` on native calls. Do not silently drop a required approval or credential behavior. Pi's default exposure is `codemode`; choose `direct` per tool when the workflow needs it.
4. Remove the separate `pi-mcp-adapter` entry from `settings.json` and any personal adapter extension only after its servers have native equivalents. Vibes no longer bundles it. Reload or start a fresh session; `pi mcp list --json` checks connection state, but is not proof that the model can use tools. Run a real prompt through representative servers and inspect actual results. Test Superhuman sends only with a disposable draft and explicit user approval; confirm an unapproved/headless send is blocked. Restore the backup if a critical connector is unavailable rather than leaving a half-migrated configuration.

Update any private instructions referring to the `mcp` proxy or `mcpScript`: native tools are `mcp__<server>__<tool>`, and codemode scripts call them via `tools.mcp__<server>__<tool>(args)`. Native `pi mcp` commands see native config only, not the adapter's old file.

## Gog keeps asking to access the macOS Keychain

If `gog` repeatedly triggers macOS Keychain access dialogs (especially after Homebrew upgrades), check `gog auth keyring` and `codesign -dv "$(which gog)"`. An ad-hoc-signed gog binary can lose its Keychain trust when replaced. Follow [gog credentials](gog-credentials.md) to set up the encrypted file keyring and migrate tokens without discarding the original Keychain entries. Switching the backend alone does not move tokens. Verify a real gog read, and check that Pi's actual launch environment has the keyring password; a Google browser sign-in is a different problem.

## Deferred tools cause a prompt-cache miss when enabled

An extension that returns a replacement `systemPrompt` from `before_agent_start` makes Pi collapse its prompt and tool history. Later tool additions then replace the initial tool list instead of appending a delta, even on models with native append-only support. The earlier eager-web workaround addressed this symptom, not a provider limitation.

Vibes adds papercut guidance through `event.systemPromptOptions.sections`, preserving its tool and instructions. During settings sync it also patches the known Google Workspace prompt hook in a separately installed official npm `@earendil-works/pi-radius-work` package. This is an optional compatibility edit, not a bundled Google integration: commands, login, status, accounts and other package files stay unchanged. The patch is idempotent and reapplies after a reinstall. Git/local forks are left alone. The edit covers global npm installs only, not project-scoped packages. If the upstream hook or a custom edit no longer matches, sync reports the failure and leaves web loading unchanged; inspect the hook rather than overwriting it blindly. If loading is already `auto`, that failure is a report, not a rollback: pin the previous Radius Work version or use `eager` until the hook is fixed.

A direct `pi update --all` or Radius Work reinstall can restore the forcing hook. Run `vibes update` afterwards to reapply the compatibility edit before starting a fresh session.

`web-search.template.json` sets `"toolActivation": "auto"`. On models with append-only support, `web_enable` loads `web_search`, `fetch_content` and `get_search_content` when needed. Other models retain pi-web-access's eager fallback. `source_check` stays disabled by default. `vibes update` preserves deliberate activation and tool overrides, and updates the config location pi-web-access already uses, including legacy `~/.pi/web-search.json` and XDG setups.

For an existing setup, update Vibes, run its settings sync and inspect any personal `before_agent_start` hooks that return `systemPrompt`. Add guidance through structured sections or `appendSystemPrompt` instead; keep genuine whole-prompt replacements only when needed. Restart Pi and start a fresh session; resumed sessions retain recorded tools. Verify an actual tool activation and cached-token usage. On OpenAI, the top-level tools and original request prefix should stay unchanged while the request appends `additional_tools`. On Anthropic, look for `tool_addition` blocks and retained cache reads; deferred definitions can also be appended to the top-level tools. Seeing model compatibility flags or reconstructing a request from the saved transcript is not enough. Herdr subagent child sessions still use their own whole-prompt override; this fix does not remove that separate source of cache misses. See [Pi extension prompt contracts](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/extensions.md#follow-the-extension-contracts) and [pi-web-access tool activation](https://github.com/nicobailon/pi-web-access#tool-activation).

## Home updates and old jobs

The home command routes `vibes update` to `scripts/home-update`. It fetches `origin/main` only, updates the local installation and verifies startup. It does not merge an upstream remote or push changes. Preserve personal settings, feature choices and existing `AGENTS.md`; `AGENTS.template.md` is optional reference material, not a managed replacement.

The home command does not install update, refresh, hotfix or upload jobs. Inspect any existing launchd or cron jobs before changing them; remove obsolete jobs only with the user's approval. Do not replace them with an automatic schedule during onboarding.

Generic refresh and hotfix utilities remain available for explicit opt-in use under `ai.vibes.*` launchd labels. They are separate from the home updater. Read their behavior before invoking or scheduling them: they may run broader package updates or configured telemetry sends. No automatic jobs are required for a home setup.

Telemetry defaults to `null` (local-only). Choose a private destination explicitly before sending; see [telemetry destinations](telemetry-destinations.md). A connection failure does not establish that credentials are invalid. Inspect the actual error rather than reinstalling packages or removing accounts to hide it.

## Prompt templates that fail to parse

```text
~/.pi/agent/prompts/do-less.md
  Nested mappings are not allowed in compact mappings at line 1, column 14
```

The frontmatter is YAML, and a `description` that contains `: ` must be quoted: `description: "Simplify recent work: cut …"`.

## Warnings that are not conflicts

- Messages from an extension about its own configuration (for example Pinet's guardrail notice) are that extension's business. Mention them to the user, but don't change their settings to hide them.
- "Package updates available" lists the user's own packages. `vibes update` leaves those alone on purpose.

## Turning off one Vibes resource

For a whole named feature, prefer `"surf": false` in `vibes.json` (see above). It disables the wrapper and the skills/prompts it brings. Use native Pi filters for individual resources or project-specific exclusions. Existing exclusions remain valid and always win over `vibes.json`.

Add an exclusion to the Vibes entry in `~/.pi/agent/settings.json`. Excluding a wrapper also turns off the skills and prompts it brings:

```json
{
  "source": "git:github.com/tmustier/vibes",
  "extensions": ["!extensions/surf.ts"],
  "prompts": ["!prompts/papercuts-review.md"]
}
```

## Checking your work

After any migration or update, and before telling the user it is done:

1. Run `vibes check`. It starts Pi in a hidden tmux session from an empty folder and prints every conflict, extension issue and load error it shows. Fix each one using this guide, then run it again until it reports a clean start.
2. Run `vibes check <folder>` for the folders the user works in that have their own `.pi` config, including the home folder if it has `~/.pi/skills/`. Project-local skills and extensions only load there. Check that the intended Vibes resource loaded, not just that the collision warning disappeared.
3. After migrating duplicates, check in `vibes inventory` that each migrated resource loads from Vibes, the old copy does not, and unrelated resources still load.
4. Run a real prompt through the tools you changed. For MCP, for example: `pi -p --no-session "Use the Linear MCP server to list the team keys."`. Inspect the tool calls as well as the answer. A config that loads is not the same as one that works.
5. Run `vibes status` after changing the update job. It shows the last result, failed step and log path. Home updates use `~/Library/Logs/pi-personal-update.log`.

Tell the user what you removed, what you turned off and why, and where the backups are.
