# Telemetry destinations

Set `telemetryDestination` in `~/.pi/agent/settings.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`). The same setting routes setup inventory, usage aggregates and update-fix reports. It does not change what each collector includes or install upload jobs.

Personal settings override `settings.template.json`. An explicit `null` keeps uploads local-only. The home distribution defaults to `null`; there is no built-in remote fallback. A distribution can choose a GitHub or HTTP default in its own template.

`vibesTelemetry: false` remains the master opt-out, including local usage collection. To enable a chosen destination after opting out, remove that flag or set it to `true`. The destination is personal configuration, not a template-managed setting: settings sync never changes it. Onboarding preserves an existing destination or opt-out.

## GitHub

```json
{
  "telemetryDestination": {
    "type": "github",
    "repository": "your-account/your-telemetry"
  }
}
```

The repository must already exist and be writable by the active `gh` account. The sender identity defaults to `gh api user`; an optional `identity` overrides the folder label. Existing GitHub file-update, timestamp-deduplication and report-append behaviour is retained. Choose a private repository appropriate for the data; do not use the public source repository as an automatic inbox.

## HTTP

```json
{
  "telemetryDestination": {
    "type": "http",
    "url": "https://telemetry.example.net/pi",
    "identity": "home-user",
    "tokenEnv": "PI_TELEMETRY_TOKEN"
  }
}
```

`identity` is required and contains letters, numbers, underscores or hyphens. HTTP uploads do not query GitHub. `tokenEnv` is optional; when present, the named environment variable must hold the bearer token. Keep the token outside tracked settings and make it available to whichever process runs the sender, including launchd if used. Missing tokens fail without falling back to another destination.

The URL is a base URL, without embedded credentials, query parameters or a fragment. HTTP and HTTPS are supported, including a local receiver for development. Use HTTPS for a remote service carrying private data. Requests have a 30-second timeout (agent default, not requested). Redirects are treated as failures, not as a new destination.

### Receiver contract

The receiver implements ordinary document reads and writes under the configured base URL:

| Path | Body |
| --- | --- |
| `people/<identity>.json` | Redacted setup inventory |
| `usage/<identity>/<installation-id>/<YYYY-MM>.json` | Complete monthly usage snapshot |
| `reports/<identity>.md` | Update-fix reports |

For each upload, the sender performs `GET <base>/<path>`. Return the current UTF-8 document with HTTP 200, or HTTP 404 when absent. Then the sender performs `PUT` on the same URL with the complete replacement document. Return a 2xx status only after accepting it. Bodies use `application/json` or `text/markdown; charset=utf-8`. The optional bearer token is sent on both requests.

Return a strong `ETag` (not a weak `W/` tag) on existing documents and enforce `If-Match` on writes to preserve concurrent report appends. Creation uses `If-None-Match: *`. HTTP 409 or 412 causes a fresh read and retry, up to the existing five upload attempts. Without ETags, concurrent edits to an existing document cannot be protected. Other failures remain pending for a later explicit or scheduled retry. There is no automatic GitHub fallback.

The receiver can store the documents in a database, object store or filesystem. It does not need to be a Git repository. It must implement this GET/PUT contract; an arbitrary POST-only analytics endpoint is not directly compatible.

## Collection and delivery

`vibes usage collect` remains local. `vibes usage send` collects first and uploads dirty months to the configured receiver. With no destination, collection still works and send reports local-only. Setup inventory and update reports retain their existing redaction rules. Usage snapshots contain aggregates, not transcript content; setup inventory can include redacted personal resource text, so choose a receiver appropriate for that data.

Usage acknowledgements are keyed by destination and identity. Switching repositories, HTTP URLs or identities sends the available snapshots to the new destination even if the old receiver acknowledged them. Changing authentication alone does not resend unchanged snapshots. Previous remote copies are not deleted.

The home updater does not install upload jobs. Selecting a destination enables explicit sends, not a new home schedule. Papercut issue submissions are a separate workflow and are not redirected by this setting.

## Checks

Run `python3 tests/test_telemetry_destination.py`, `python3 tests/test_inventory.py` and `python3 tests/test_usage_telemetry.py`. Transport tests run the actual CLIs against an isolated local HTTP receiver. They cover redaction, report appends, conditional-write conflicts, auth failures, redirects, missing settings, usage retries, deduplication and destination changes. No production telemetry is sent.
