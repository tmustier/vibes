---
name: chrome-cookies
description: Extract session cookies from Chrome on macOS by decrypting Chrome's cookie database. Use when you need to authenticate API calls using the user's existing browser session — e.g., refreshing expired session cookies, accessing a service the user is logged into, or bootstrapping API access for a tool that uses cookie auth. Triggers include "refresh cookies", "my session expired", "grab cookies from Chrome", "authenticate using my browser session", "401 from API", or any task where the user is logged into a site in Chrome and you need those credentials for programmatic access.
---

# Chrome Cookie Extraction (macOS)

Extract and decrypt cookies from the user's Chrome browser on macOS. No browser automation, no debug ports, no passwords needed — reads the encrypted cookie SQLite DB directly using the Chrome Safe Storage key from macOS Keychain.

## When to use

- API returns 401 and the user says "I'm logged in" — refresh the session cookies
- Setting up programmatic access to a service where the user has a browser session
- A cookie-based service that has no supported API, MCP, or OAuth path

## How it works

Chrome stores cookies in a SQLite database (`~/Library/Application Support/Google/Chrome/<Profile>/Cookies`), encrypted with AES-128-CBC. The encryption key is derived from a password stored in macOS Keychain under "Chrome Safe Storage". This script reads both, decrypts, and outputs the plaintext cookie values.

## Requirements

- macOS (uses Keychain + Chrome's macOS cookie encryption)
- [`uv`](https://docs.astral.sh/uv/) and Python 3.11+; the executable provisions `cryptography` itself
- Chrome must have the cookies (user is logged in)
- Chrome does NOT need to be quit — reads the DB in read-only mode

## Usage

The helper script is at the skill directory: `extract.py` (resolve relative to this SKILL.md).

Resolve `SKILL_DIR` to this skill's directory before running the helper.

```bash
# Extract all cookies for an exact domain
uv run "$SKILL_DIR/extract.py" --domain app.example.com

# Extract specific cookies
uv run "$SKILL_DIR/extract.py" --domain app.example.com --names session_id csrf_token

# Output as curl cookie header (pipe to curl -H "Cookie: ...")
uv run "$SKILL_DIR/extract.py" --domain github.com --curl

# Output as env vars
uv run "$SKILL_DIR/extract.py" --domain app.example.com --env

# Get a single cookie value (for scripting)
uv run "$SKILL_DIR/extract.py" --domain app.example.com --names session_id --value

# Specify a Chrome profile (default: auto-detect)
uv run "$SKILL_DIR/extract.py" --domain app.example.com --profile "Profile 1"

# Include true subdomains (.example.com and app.example.com, never notexample.com)
uv run "$SKILL_DIR/extract.py" --domain example.com --include-subdomains
```

## Known limitations

- **macOS only** — the Keychain integration and Chrome cookie encryption format are macOS-specific. Linux Chrome uses a different key derivation. Windows uses DPAPI.
- **Chrome profiles** — the script checks Default and numbered profiles, or accepts an explicit `--profile`.
- **Encrypted-at-rest cookies only** — if Chrome hasn't synced/written the cookie to disk yet (very fresh session), it might not be in the SQLite DB. Wait a moment and retry.
- **v10 format** — handles Chrome's v10 (AES-128-CBC) encryption. If Chrome changes to a new format, the script will need updating.
- **CBC first-block garbage** — the decryption produces 16-32 bytes of garbage at the start (Chrome's static IV issue). The script heuristically finds the real value start (JWT prefix, skip garbage prefix). This works for all observed cookie formats but could theoretically mismatch on unusual values.

## Why this still exists alongside Surf

Prefer Surf when the work can run inside the user's logged-in Chrome. Use this skill only when a non-browser API explicitly needs session cookies and no supported API, MCP or OAuth route exists.

Chrome 145+ blocks remote-debugging access to the default profile. This skill instead reads the cookie database directly; never use it merely as a shortcut for browser control.
