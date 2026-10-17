# claude-code-artifact

Publish, fetch, edit, or update a self-contained HTML or Markdown page as a
**Claude Code Artifact**, including pages that call the viewer's claude.ai MCP
connectors for live data and actions.

The fast path uses `scripts/publish-artifact-direct.py`, which calls Claude
Code's frame deploy/read APIs directly and avoids driving the interactive TUI
through tmux. CSP/image-inlining, auth, read/edit/update-in-place, size limits,
and the tmux fallback live in [`SKILL.md`](./SKILL.md).

## Helpers

- `scripts/inline-assets.py INPUT.html [OUTPUT.html]` — produces a CSP-safe
  self-contained copy (images as data URIs, CSS/JS inlined), leaving the
  original untouched. Prints rendered size and warns past the 5 MiB / 16 MiB
  thresholds.
- `scripts/publish-artifact-direct.py FILE.html --title "Title" --favicon "🐆"`
  — publishes directly to `https://claude.ai/code/artifact/<uuid>` using Claude
  Code's stored claude.ai OAuth login. Pass `--url <artifact-url>` to update in
  place.
- `scripts/publish-artifact-direct.py --show-contract` and
  `--show-capability mcp` — inspect the current served artifact runtime without
  launching Claude Code.
- `scripts/publish-artifact-direct.py --list-connectors` — list the account's
  configured claude.ai connectors. Publish a connector declaration with
  `--mcp "Slack" "slack_search_public"` (repeat as needed).
- `scripts/publish-artifact-direct.py --fetch <artifact-url> --output artifact.html`
  — fetches the current HTML and metadata for an artifact the Claude account can
  access.

## Installation

Ships with Vibes but is not installed by default. To opt in, add it to `skills`
in `~/.pi/agent/settings.json` (see the Vibes README). Once installed, both you
and Pi can use it. Choose a sharing destination explicitly; publishing this skill
does not configure an organization or grant access to one.
