# google-workspace-stack

A small Pi skill and local toolchain for Google Workspace work.

It keeps the agent model simple:
- use **`gog`** by default for routine Google Workspace tasks
- use the authenticated **`gws`** wrapper for advanced raw Google Workspace API operations
- prefer **live in-place edits** over export/reimport loops

## Why this exists

The goal is to make Google Workspace usage:
- easy for a no-context agent to understand
- easy to maintain locally
- easy to update from upstream without carrying a fork
- reproducible via a pinned upstream vendor lock

## What is in this repo

- `SKILL.md` — the main routing skill for Pi
- `vendor.lock.json` — pinned upstream ref/commit/version for `googleworkspace/cli`
- `references/` — routing, live-edit, and command guidance
- `scripts/gws` — authenticated wrapper around the vendored Google Workspace CLI
- `scripts/gws-raw` — direct passthrough to the vendored upstream binary
- `scripts/gwsa` — compatibility alias to `gws`
- `scripts/sync-googleworkspace-cli.sh` — update/rebuild helper for the pinned upstream CLI
- `scripts/doctor.sh` — preflight checks
- `scripts/smoke-test.sh` — non-destructive validation checks

## Stack

### Default layer
Use `gog` for routine tasks across:
- Gmail
- Calendar
- Drive
- Sheets
- Docs
- Slides

### Advanced layer
Use `gws` for API-only features that `gog` does not expose cleanly, especially:
- Sheets `batchUpdate`
- Docs `batchUpdate`
- Slides `batchUpdate`
- advanced Drive / Calendar / Gmail endpoints

## Quickstart

```bash
# 1) Install current gog and authenticate
brew install openclaw/tap/gogcli
#    (example: gog auth add you@example.com --services gmail,calendar,drive)

# 2) Build the pinned upstream gws and install local command links
./scripts/sync-googleworkspace-cli.sh

# 3) Verify environment and auth
./scripts/doctor.sh

# 4) Run non-destructive live checks
./scripts/smoke-test.sh
```

If you are using this as a local Pi skill, run `/reload` in Pi after changes.

## Prerequisites

This repo assumes:
- current `gog` (0.34.0 or newer) is installed and authenticated for the target Google account
- `git`, `jq`, `curl`, `python3`, and `cargo` are available
- the current OAuth project used by `gog` has the relevant Google APIs enabled

The tooling reuses `gog` credentials rather than maintaining a separate `gws auth login` flow.

## Required and useful Google APIs

The exact APIs you need depend on what you want to do. In practice, the stack is most useful when these are enabled in the Google Cloud project behind your `gog` OAuth client:

- **Drive API** — file discovery and metadata
- **Gmail API** — mailbox operations
- **Calendar API** — calendar operations
- **Sheets API** — live spreadsheet reads/writes and advanced batch operations
- **Docs API** — live Google Docs reads/writes and `batchUpdate`
- **Slides API** — native Google Slides reads/writes and `batchUpdate`
- **Meet API** — optional, for Meet-specific work

If an API is disabled, live checks and real operations for that service can fail with `403 accessNotConfigured`.

## Local paths

Defaults:
- skill path: `~/.pi/skills/google-workspace-stack`
- vendored upstream repo: `~/.pi/vendor/googleworkspace-cli`
- command links: `~/.local/bin/gws`, `~/.local/bin/gws-raw`, `~/.local/bin/gwsa`

Environment overrides:
- `GWSTACK_VENDOR_DIR`
- `GWSTACK_RAW_GWS_BIN`
- `GWSTACK_BIN_DIR`
- `GWSTACK_LOCK_FILE`

## Usage

### Routine operations
```bash
gog gmail search "newer_than:7d" --json
gog calendar list --days 7 --json
gog drive search "pipeline" --json
gog sheets get <spreadsheetId> 'Sheet1!A1:C10' --json
```

### Advanced raw API operations
```bash
gws schema sheets.spreadsheets.batchUpdate
gws drive files list --params '{"pageSize":5,"fields":"files(id,name),nextPageToken"}'
gws sheets spreadsheets batchUpdate --params '{"spreadsheetId":"SPREADSHEET_ID"}' --json '{"requests":[...]}'
```

## Validation commands

Rebuild from the pinned upstream ref and refresh command links:

```bash
./scripts/sync-googleworkspace-cli.sh
```

Run preflight checks:

```bash
./scripts/doctor.sh
```

Run the wrapper regression test and non-destructive live smoke test:

```bash
./tests/test-gws-public-client.sh
./scripts/smoke-test.sh
```

### What `doctor.sh` checks

- required local commands exist
- the vendor lock file exists
- the vendored upstream repo and built raw `gws` binary exist
- `gws` and `gws-raw` are on PATH
- `gog` has an authenticated account and client credentials
- the authenticated `gws` wrapper can run and resolve schema

### What `smoke-test.sh` checks

`smoke-test.sh` is **non-destructive**. It performs live reads and schema checks, not writes.

It currently validates:
- `gog` + `gws` versions
- Gmail
- Calendar
- Drive
- Google Sheets metadata reads when a native Sheet is discoverable
- Google Docs info reads when a native Doc is discoverable
- raw schema checks for Sheets / Docs / Slides batch operations

## Shared drive behavior

Native Google files may live in **shared drives**, not just My Drive.

The smoke test now searches across all drives using:
- `includeItemsFromAllDrives=true`
- `supportsAllDrives=true`
- `corpora=allDrives`

So if a native Google Sheet or Doc exists in a shared drive, the smoke test should be able to find it.

## Troubleshooting

### `gws` is not on PATH
Run:

```bash
./scripts/sync-googleworkspace-cli.sh
```

This rebuilds the pinned upstream binary and refreshes command links into `~/.local/bin/`.

### `403 accessNotConfigured`
The relevant Google API is not enabled in the current OAuth project.

Enable the missing API in Google Cloud Console, then retry.

### `gws` works but a live service check fails
That usually means one of:
- the API for that service is disabled
- the account lacks access to the target object
- the object exists only in a drive scope your query did not include

### Smoke test warns that no native Google file was found
That means the test could not find a file of that native type, e.g. a true Google Slides presentation (`application/vnd.google-apps.presentation`).

Note that `.pptx`, `.docx`, and `.xlsx` files are **not** the same as native Google Slides/Docs/Sheets files.

### Public OAuth clients without a client secret

Installed/public OAuth clients may omit `client_secret` from `credentials.json` because gog keeps it in the OS keyring. The wrapper reuses the valid short-lived access token from `gog auth tokens export`, allowing gog to remain the credential broker. Direct refresh is only a fallback for credentials files that contain both client ID and secret.

### Auth/account mismatch
Check:

```bash
gog status --json
gog auth list --json
```

If needed, set a specific account for the wrapper:

```bash
gws --gog-account you@example.com version
```

## Notes

- The authenticated wrapper is `gws`.
- `gwsa` still works as a compatibility alias, but new usage should prefer `gws`.
- `gws-raw` bypasses the wrapper and calls the vendored upstream binary directly.

## License

MIT
