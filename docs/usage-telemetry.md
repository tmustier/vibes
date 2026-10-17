# Transcript usage telemetry

`scripts/usage-telemetry` is a Python 3 standard-library collector. The home distribution defaults to a null telemetry destination and installs no
upload jobs. Optional refresh utilities can call it separately from setup inventory;
this script does not install anything, schedule jobs, or launch Pi.

```sh
scripts/usage-telemetry collect
scripts/usage-telemetry send
scripts/usage-telemetry collect --inventory /path/to/raw-inventory.json
scripts/usage-report /path/to/vibes-telemetry --from 2026-10-01 --to 2026-10-14
```

The agent directory is `PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`. Both collector
commands use `<agent>/vibes-inventory.json` by default when present. `--inventory`
overrides it. Only the resource mapping is cached in local state, not inventory
text. Missing inventory is safe: built-in tools remain recognizable, known skills
under the agent and this bundle can be recognized, and unattributed extensions
are `unknown`. A new mapping reparses available history once to improve attribution.
The mapping is a current startup observation, **not proof of historical ownership**.

`collect` updates local state and prints `{"enabled":true,"periods":{...}}` JSON.
It does not query GitHub or upload. `send` collects first and uploads each dirty
month through the configured [telemetry destination](telemetry-destinations.md).
GitHub destinations use the current login unless an identity is configured. HTTP
destinations use an explicit identity and need no GitHub account. A null destination
keeps collection local. Output from `send` is human-readable connector
status, not JSON. Exit status is nonzero if authentication or any upload fails.
No telemetry-repository writes occur except when `send` is explicitly run.

For explicitly enabled generic refresh utilities, `vibes-update.json` uses `ok` for installation success; individual `telemetry` and `usage-telemetry` steps retain upload outcomes. Upload-only failures are reported as “Update succeeded; telemetry upload pending”, not installation failures. Retry explicitly after checking the destination and error. The home updater does not install a retry schedule or send inventory.

## What is stored and uploaded

Daily UTC buckets are an **agent-default, not a user rule**. The entry timestamp
sets the UTC date (message timestamp is a fallback). The upload destination is:

```text
usage/<identity>/<installation-id>/<YYYY-MM>.json
```

Each schema-1 document has `githubLogin` when using the GitHub login, or `sender`
when using an explicit identity, a random local `installationId`,
`bucket: "daily-UTC"`, and `days` keyed by `YYYY-MM-DD`. A day's fields are:

- `models`: rows grouped by `kind`, `provider`, requested `model`, `responseModel`,
  requested `thinkingLevel`, and `providerThinkingLevel`. Missing dimensions are
  explicitly `unknown`. Assistant-local metadata wins; missing model/thinking
  fields use ancestor metadata in the persisted branch (chronological metadata
  for old entries without parent links). All branches count, not just the active
  branch. Provider thinking is never inferred from requested thinking. Summaries
  and tool usage do not inherit the conversation model: it may be a different model.
- Each model row preserves recorded `input`, `output`, `cacheRead`, `cacheWrite`,
  `cacheWrite1h`, `reasoning`, `totalTokens`, cost components and `records`.
  Reasoning is already part of output; cacheWrite1h is already part of cacheWrite.
  They are **not added again**. Missing numeric fields contribute zero; these are
  recorded totals, not estimates of missing usage. Costs retain Pi's recorded
  estimates, not a recomputation with current prices or a billing statement.
- `cacheHitPercent` = sum(cacheRead) / sum(input + cacheRead + cacheWrite) × 100;
  null when that denominator is zero. Never average percentages across records.
- `tools`: attempts, results, errors, unfinished, grouped by tool/extension and
  whether the call is nested. Results/errors are assigned to the attempt's UTC
  day, even if the result arrives later. Errors are a subset of results.
- `nestedCoverage`: counts of result records with `complete`, `incomplete`, or
  `unrecorded` nested-call metadata. Only explicit `complete: false` is incomplete;
  absent metadata (including normal successful tool results) is unrecorded, not
  evidence of zero nested calls or failed instrumentation.
  `nestedCalls.calls` supplies nested names/statuses; arbitrary exec/bash strings
  are never scraped for inferred tool invocations.
- `skills`: successful recognized `read` calls to known `SKILL.md` paths, including
  structured nested reads. This means **file loaded**, not “skill followed”. A
  read attempt without a successful result does not count as a skill load.
- `extensions`: attributed tool-attempt counts. `loadedResources` separately counts
  enabled extension resources observed in each distinct inventory snapshot;
  repeated processing of the same snapshot does not add another observation.
  Resource observations are not invocation counts, and snapshots are not every
  Pi startup. Passive hooks and commands are not counted as invocations.

Uploads contain **no prompts, messages, summaries, arguments, outputs, paths,
session IDs, run IDs, or project paths**. Structured identity fields preserve bounded
readable names: letters, digits, underscores, dots, colons and hyphens, up to 128
characters, with no traversal segments. For example `web_enable`, `fetch_content`,
`mcp__linear__list_issues`, `unslop`, and `claude-fable-5-1` remain readable.
Model IDs may have one provider namespace (`anthropic/claude-fable-5-1`). Extension
sources normalize to package names (`pi-subagents`, `@scope/package`) or repository
identifiers (`github:owner/repo`), never URLs, credentials, refs, or installed paths.
Unsafe identity strings become stable bounded
`other-<hash>` labels; absent identities are `unknown`. These hashes allow grouping,
not anonymization against someone who can guess a name. The raw inventory's text
and paths are never copied into a usage upload. The configured sender identity
intentionally identifies the user. Setup inventory has its own broader data contract.

## Offline operation and duplicate accounting

State lives in `<agent>/usage-telemetry/state.sqlite3` (directory 0700, database
0600). It includes a stable installation ID, local file offsets/hashes, branch
metadata, sanitized accounting records, local resource paths/references, durable
monthly aggregates, and acknowledged upload hashes keyed by destination and identity.
Changing destination resends the available snapshots to the new receiver; it does
not delete copies at the previous receiver. SQLite transactions serialize
collectors/senders. Do not copy this state to another laptop: each installation
needs its own ID. Keep state across upgrades; deleting it loses the upload ledger
and generates a new installation ID, which can duplicate historical totals.

Discovery visits only `<agent>/sessions/` and the Vibes Pi migration roots
`<agent>/vibes-pi-1-*/sessions/`, including their nested forks. It does not discover
sessions inside installed `git`, `npm`, `extensions`, or `node_modules` trees.
The sessions root may be a symlink, and linked files are deduplicated normally;
nested directory symlinks are not recursively followed. Custom session directories outside those known roots
require explicit child `sessionFile` references. Those referenced files are read
directly; their surrounding package/project directories are not recursively scanned.
It never recursively searches projects or HOME outside the agent directory. Only
files with a Pi session header are accepted; subagent `recordType` debug mirrors
are excluded. Literal session copies and forks are deduplicated using original
entry IDs plus timestamps/type/response identity, not the new session ID or
rewritten parent link. Id-less legacy entries use content fingerprints locally;
modified id-less copies cannot always be recognized.

Unchanged files are skipped; appended complete lines are parsed incrementally.
Changed files' already-consumed prefixes are hashed before trusting the offset,
so truncation and same-size replacement trigger a reparse. Partial trailing lines
wait for a newline; malformed complete lines and entries without usable timestamps
are skipped, never interpreted as text. Previously observed usage survives file
deletion/truncation. There is no retention cap or lookback cutoff. Parsing is
incremental, but aggregate rebuilding currently visits all local accounting records.
Parser version 3 forces available in-scope transcripts to reparse for readable
names even if inventory mappings have not changed. Previously collected deleted
history remains durable. Pre-acceptance state produced by the old broad scanner
can retain fixture totals; use a fresh disposable agent directory for acceptance,
not a production-state reset (which would create a new installation ID).

Assistant, standalone `usage` (including cache warming), compaction, branch-summary
and tool-result usage remain distinct kinds. `tokensBefore` is not billed usage.
Subagent `details.results` and `details.completions[].results` summaries are counted
once per run/reference only when the referenced child session has not been read.
When that session appears, the child entries replace the summary contribution,
including inherited-history deduplication. Summary-only usage has unknown model
dimensions and belongs to the parent result's date, not inferred child dates.
Repeated receipts for the same run/result use the latest recorded summary.
Relative child references resolve against the parent transcript directory. A
`runId` can also identify `<parent-stem>/<runId>/run-<index>/session.jsonl`, or the
single scanned session in that directory. Resolution evidence is unioned across
copies of the same parent event so stale copied paths do not reintroduce usage.

Every unacknowledged/changed month is retried, however old. Successful months are
acknowledged independently; a failed month does not prevent later months being
attempted. Uploads replace a complete monthly snapshot rather than incrementing
remote counters. A crash after upload but before acknowledgement can resend the
same snapshot safely. Late tool results or newly discovered child sessions can
correct old months. The inventory connector provides its existing network retries.

## Cross-check against the bundled usage extension

Checked the published `pi-extensions@0.1.67` usage-extension `data.ts` and
[CHANGELOG](https://github.com/tmustier/pi-extensions/blob/4a63a2ebd3683d86597e226c7ff778ea4837dd73/usage-extension/CHANGELOG.md).
Its 0.9.5/cache-v6 parser uses **scanned child-file presence**. Exact contiguous
token/cost matching and residual subtraction belonged to 0.9.3 and were removed
in 0.9.4. This collector shares v6's header requirement, recursive child discovery,
relative/run-derived references, copied-parent resolution evidence, and preference
for scanned children (including v6's truncated-child undercount limitation).

Intentional differences:

- Deduplication uses original event identity, not v6's assistant timestamp + summed
  token fingerprint. Distinct events with equal timestamps/token sums still count.
- For recognized subagent results with child usage, only unscanned children's
  summaries count alongside scanned child work. V6 instead adds the entire canonical
  parent aggregate when *any* child is missing: children costing 1 and 2 with only
  the first scanned yield cost 4 in v6, versus 3 here. No token-vector matching of
  unrelated sessions is attempted. Parent aggregate overhead beyond the listed
  children is not recovered; canonical totals with incomplete child breakdowns
  remain a coverage gap rather than speculative residual arithmetic. Generic
  top-level tool usage without child accounting is retained normally.
- Assistant-local model/effort fields and ancestral branch metadata outrank
  chronological global metadata. Legacy entries without parent links still replay
  chronological metadata. Provider thinking and responseModel remain separate.
- Standalone native usage and auxiliary kinds remain distinct, with recorded model
  attribution where present and `unknown` otherwise, not synthetic Tools/summaries.
- Stored token fields are not v6's dashboard “Tokens” (input + output + cacheWrite).
  Recorded totalTokens and cacheRead stay available independently.

Regression fixtures cover copied history and stale parent paths, equal-token
identity collisions, nested/run-derived sessions, partial/missing/truncated
children, generic tool usage, branch effort, and cache weighting. These tests
check our stated policy rather than claiming byte-for-byte dashboard parity.

## Period queries and limits

`usage-report` reads a local telemetry checkout only. `--from` and `--to` are
inclusive UTC dates. Its JSON `users` map sums all installations and months for
each GitHub login, preserving model/effort/kind dimensions and recomputing weighted
cache rates. It sums tool/skill/extension/resource counts too. It does not fetch,
push, install, or mutate files. Unknown schemas or duplicate installation/day
documents fail rather than silently doubling totals. Empty periods return an
empty users map. Cross-installation copied transcript history cannot be deduplicated
from aggregate-only uploads; avoid copying sessions between installations used for
reporting. Weeks/months are queries over daily buckets, not separate uploads.

Historical gaps are unavoidable:

- Slash commands are not all persisted. No slash-command totals are invented.
- Old transcripts may lack usage, effort, nested metadata, skill paths or child
  references. Opaque exec content is not evidence of a tool/skill invocation.
- Async subagent artifact-only usage and custom slash-result envelopes without
  standard tool-result references are not reconstructed. An available but incomplete
  child session is preferred over its summary; unpersisted child usage is missing.
  Summaries without a usable run/reference identity cannot be reliably reconciled
  with independently discovered child files.
- Missing original history, rewritten IDs, and legacy timestamp-free records limit
  deduplication and coverage. Unmatched result-only records provide nested coverage
  but cannot invent an attempt or its date.
- Current inventory attribution can differ from the extension that owned the tool
  historically. Unknown is preferable to assigning usage from current active-branch
  state or inventing a model for summaries.

Set `"vibesTelemetry": false` in `<agent>/settings.json` to stop **both collection
and uploads** before inventory/transcript reads or state creation. Commands print
`{"enabled":false,"periods":{}}` and exit successfully. Existing local state and
already-uploaded aggregates are not deleted. Re-enabling catches up available
history, including the disabled interval; this is an opt-out from running the
collector, not a timestamp-based exclusion policy.

## Validation

Run `python3 tests/test_usage_telemetry.py` and `python3 tests/test_refresh.py`.
Fixtures follow Pi 1.2.0 session v3 and pi-subagents 0.78.0 result shapes.

Local acceptance on 14 October 2026 tested runtime revision `eb10b75` with the
managed templates in an isolated agent directory. The provider/model was
`openai-codex/gpt-6.1-sol`, with medium thinking. The prompt asked the model to
read `skills/unslop/SKILL.md` through the structured reader, write a scratch proof
file, and run the collector's actual `collect` CLI. It made 3 read calls and one
bash call. Host assertions verified the proof file, one `unslop` load, built-in
tool attribution, 5 assistant requests and exactly 43,163 recorded tokens
(10,141 fresh input, 32,768 cache read, 254 output). They also verified the cache
formula, effort labels, unchanged counters on a repeated scan and absence of test
prompt/output/path content from the aggregates. Scratch prompts and session records are local test artifacts, not part of the published evidence.

A separate real macOS launchd check seeded 30-day-old update state. RunAtLoad
triggered one update, then a periodic tick retried a failed upload without another
update. The installer, lock and scheduler were real; installation and upload
commands used scratch fixtures. The test job was removed and its absence checked.
The collector/report suite (19 tests), scheduler suite (8 tests), type checking,
isolated Pi startup, feature startup, existing Node suites and updater integration
tests passed locally.

Live GitHub uploads, other providers, every legacy transcript shape and every
passive extension/command are not acceptance claims. Upload integration tests use
the existing inventory connector with a fake `gh`; no test usage was uploaded.
A separate local review-agent launch was unavailable because the installed older
subagents package required Chord, which Pi 1.2 does not ship. Direct code review
and runtime verification were completed without changing that installed setup.
