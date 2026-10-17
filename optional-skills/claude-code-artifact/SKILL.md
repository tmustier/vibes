---
name: claude-code-artifact
description: Publish, fetch, update, or edit Claude Code Artifacts on claude.ai, including connector-backed artifacts that call a viewer's claude.ai MCP connectors for live reads and actions. Use for "Claude Code artifact", "CC artifact", "artifact link", live artifact dashboards/apps, MCP-enabled artifacts, or an existing claude.ai/code/artifact URL. Not for general public web hosting or apps that need their own backend or routes.
---

# Claude Code Artifact

Publish one self-contained HTML or Markdown page to
`https://claude.ai/code/artifact/<uuid>`. The page has no backend or routes.
Its one supported path to live external data is the viewer's claude.ai MCP
connectors.

## Direct helper

Use the helper instead of launching Claude Code. It uses the same frame APIs as
Claude Code's native `Artifact` tool.

```bash
SKILL=<directory containing this SKILL.md>
HELPER="$SKILL/scripts/publish-artifact-direct.py"
```

### Inspect the live runtime and connector roster

Do this before authoring connector runtime code. The contract is versioned and
the served definitions are authoritative over remembered API shapes.

```bash
python3 "$HELPER" --show-contract
python3 "$HELPER" --show-capability mcp --output /tmp/claude-artifact-mcp.d.ts
python3 "$HELPER" --list-connectors
```

`--list-connectors` reads the account's claude.ai connector roster. Its `tools`
arrays may be empty, so observe the intended tool once through an already
connected MCP client before publishing. Record the exact upstream tool name,
input schema, and result shape. Do not guess them. If the current agent cannot
call the connector, a one-shot Claude Code session with `ToolSearch` is a
fallback for observation; it is not required for publishing.

### Author connector runtime code

Use `window.claude.mcp` from the fetched definitions:

- `listTools()` discovers the manifest tools connected for this viewer.
- `watchTool()` keeps displayed read-only data current.
- `callTool()` performs one action or one explicit read.
- `invalidate()` refreshes cached reads after an action.

Feature-detect with `window.claude.mcp === undefined`. Branch failures on
`error.code`, especially `needs_reauth`, `server_not_connected`,
`selection_required`, `blocked_by_policy`, `approval_required`, and
`tool_error`. Retry only errors with `retryable: true`, at most once per visible
refresh, and never automatically retry writes.

Minimal pattern using an observed Slack read:

```html
<button id="load">Check Slack</button><pre id="out">Not loaded.</pre>
<script>
const out = document.getElementById("out");
document.getElementById("load").addEventListener("click", async () => {
  if (window.claude.mcp === undefined) {
    out.textContent = "MCP is unavailable in this view.";
    return;
  }
  try {
    const result = await window.claude.mcp.callTool(
      "Slack",
      "slack_search_public",
      {query: "__example__", include_context: false},
      {cache: {staleTime: 30000}}
    );
    out.textContent = JSON.stringify(result.payload, null, 2);
  } catch (error) {
    if (error.code === "needs_reauth") {
      out.textContent = "Reconnect Slack in Claude Settings > Connectors.";
    } else if (error.code === "server_not_connected") {
      out.textContent = "Add Slack in Claude Settings > Connectors.";
    } else {
      out.textContent = `${error.code}: ${error.message}`;
    }
  }
});
</script>
```

### Publish without Claude Code

Inline local assets, then declare the smallest connector/tool manifest the page
actually calls. `SERVER` must be the exact connector display name from
`--list-connectors`; `TOOL` is the observed upstream tool name.

```bash
python3 "$SKILL/scripts/inline-assets.py" report.html
python3 "$HELPER" report.selfcontained.html \
  --title "Live Slack check" \
  --favicon "📡" \
  --mcp "Slack" "slack_search_public"
```

Repeat `--mcp SERVER TOOL` for more tools or connectors. The helper fetches the
current runtime contract and pins the published version. Use `--contract 0.1.12`
only for an intentional pin or rollback.

On redeploy, omitting `--mcp` preserves the stored declaration. Passing one or
more `--mcp` options replaces the full declaration. Use
`--clear-capabilities` to revoke all stored runtime capabilities.

### Fetch and update

```bash
python3 "$HELPER" --fetch "https://claude.ai/code/artifact/<uuid>" \
  --output artifact.html

python3 "$SKILL/scripts/inline-assets.py" artifact.html
python3 "$HELPER" artifact.selfcontained.html \
  --url "https://claude.ai/code/artifact/<uuid>" \
  --base-version "<version-from-fetch>" \
  --label "revised"
```

Use `--base-version` after fetching so a concurrent update returns 409 instead
of clobbering. Reconcile first, then omit it only for an intentional overwrite.

## Connector setup boundary

- Published artifacts can call only remote connectors configured on the
  viewer's claude.ai account. Local `.mcp.json`, stdio, plugin-only, and other
  machine-local MCP servers can supply build-time data but cannot run in the
  published page.
- Existing connectors can be listed in the background with
  `--list-connectors`. Anthropic exposes no create method on that scoped API;
  adding a directory or custom connector remains a Claude web settings action.
- Pro and Max users add custom remote MCP URLs under Customize > Connectors.
  Team and Enterprise Owners add/enable them under Organization settings >
  Connectors; members then connect individually.
- A custom connector must be reachable from Anthropic's cloud over remote HTTP.
  Upstream OAuth or tenant consent still requires the relevant user/admin.
- Every viewer uses their own connector account and approves an artifact's first
  connector access. The artifact never receives credentials.

Once a connector is configured and authenticated, subsequent connector-backed
artifacts can be authored and published entirely with the helper.

## Constraints

1. **Self-contained page.** Inline CSS/JS and embed images as data URIs. The CSP
   blocks external scripts, styles, fonts, images, `fetch`, XHR, and WebSockets.
   MCP calls are the brokered exception.
2. **16 MiB rendered limit.** Base64 inflates images. Recompress/downscale when
   needed, then rerun `inline-assets.py`.
3. **Sharing.** Artifacts start private. A connector-backed artifact cannot be
   publicly shared on any plan. Team/Enterprise can share it inside the
   organization; each viewer still needs their own connector.
4. **Auth and plan.** Publishing requires Pro, Max, Team, or Enterprise,
   artifacts enabled, and claude.ai OAuth (`claude auth login` or `/login`). API
   keys, Bedrock, Vertex, Foundry, and gateway credentials do not work.
5. **No secret embedding.** Never put connector tokens, OAuth secrets, cookies,
   or API keys in artifact HTML or publish logs.

The helper resolves OAuth from `CLAUDE_CODE_OAUTH_TOKEN`, its file descriptor,
Claude Code's macOS Keychain item, or `.credentials.json`, and refreshes stored
OAuth tokens when needed.

## Private API maintenance

Verified against Claude Code 2.1.211 and artifact contract 0.1.12 on 2026-07-16.

- Deploy: `POST https://claude.ai/api/frame/deploy/direct`
- Contract: `GET /api/frame/contract/latest` and
  `GET /api/frame/contract/<version>/<capability>.d.ts`
- MCP payload:
  `capabilities.mcp.servers = [{"server": "Slack", "tools": ["slack_search_public"]}]`
- Account connector roster: `GET https://api.anthropic.com/v1/mcp_servers`
  with OAuth scope `user:mcp_servers`
- Read: `GET /api/frame/<slug>`, then the signed
  `*.frame.claudeusercontent.com/_f/<version>/` URL

If these private endpoints change, use the interactive native `Artifact` tool
while updating the helper. Never print OAuth tokens, cookies, asset tokens, or
signed upload URLs.

Reference: https://code.claude.com/docs/en/artifacts
