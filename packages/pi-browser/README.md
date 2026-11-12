# Pi browser

Vibes bundles this persistent, agent-controlled browser for Pi on macOS. It runs Playwright's Chrome for Testing headless, never a second copy of Google Chrome.app, so macOS keeps sending the user's links and AppleScript to their own Chrome. It can import Chrome cookies through macOS Keychain, giving agents a separate logged-in browser without attaching to the everyday Chrome window. Chrome and `uv` are required for cookie import; the browser itself works without imported cookies. The first launch installs Chrome for Testing with Playwright if it is missing.

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

The persistent profile is stored at `~/.pi/agent/browser/chrome-for-testing-profile`. Earlier versions ran Google Chrome on `~/.pi/agent/browser/chrome-profile`; the first launch moves that profile's cookies across, stops its Chrome and moves the old profile to the Trash. If Chrome stops answering for 5 seconds while it still holds the profile, the next action kills it and starts a fresh one on the same profile; the most recent unsaved changes in that profile may be lost. Pages the session had open close with it: an action on one of them says so, and `open` opens the page again. Raw cookie values are never written to Pi sessions or tool output. The temporary Playwright state used during import is deleted immediately after installation.

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
- `stop` (exits the browser process, killing it if it is hung; it never starts one)

Agents should call `snapshot` after navigation, then use stable refs such as `e3` for click and fill. Playwright selectors remain available as a fallback.

## Scope and limitations

The import covers Chrome cookies. Sites whose authentication depends on localStorage, IndexedDB, passkeys or device-bound state may still require an interactive login. Re-run `/browser-import` after important Chrome login changes.

## Tests

`npm run test:browser` runs the unit tests. `node --experimental-strip-types tests/pi_browser_acceptance.mjs` drives the real tool in a scratch HOME on macOS: it migrates a running old Google Chrome profile, checks the browser registers as Chrome for Testing rather than `com.google.Chrome`, checks `stop` ends the process, and checks a hung Chrome is replaced, stopped, and can't block Escape.
