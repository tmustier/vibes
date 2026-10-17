# Pi browser

Vibes bundles this persistent, agent-controlled Chrome profile for Pi on macOS. It can import Chrome cookies through macOS Keychain, giving agents a separate logged-in browser without attaching to the everyday Chrome window. Chrome and `uv` are required for cookie import; the browser itself works without imported cookies.

## Setup

To copy login cookies, run:

```text
/browser-import
```

Choose a Chrome profile and confirm. The importer reads Chrome's Cookies database while Chrome remains open, asks macOS Keychain for `Chrome Safe Storage`, and installs the decrypted cookies directly into Pi's persistent Chrome profile.

For a domain-scoped import:

```text
/browser-import Default github.com google.com
```

The persistent profile is stored at `~/.pi/agent/browser/chrome-profile`. Raw cookie values are never written to Pi sessions or tool output. The temporary Playwright state used during import is deleted immediately after installation.

## Commands

- `/browser-import [profile] [domain ...]` — import all or selected Chrome cookies
- `/browser-status` — show process and cookie count
- `/browser-reset` — stop the browser and move its profile to Trash

## Agent tool

The extension registers one `browser` tool with these actions:

- `status`
- `open`
- `snapshot`
- `click`
- `fill`
- `press`
- `wait`
- `screenshot`
- `tabs`
- `close`
- `stop`

Agents should call `snapshot` after navigation, then use stable refs such as `e3` for click and fill. Playwright selectors remain available as a fallback.

## Scope and limitations

The import covers Chrome cookies. Sites whose authentication depends on localStorage, IndexedDB, passkeys or device-bound state may still require an interactive login. Re-run `/browser-import` after important Chrome login changes.
