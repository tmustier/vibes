---
name: artifact-capabilities
description: Runtime capabilities a published Claude artifact can be granted, such as live claude.ai connector data, a shared database, uploaded files, downloads, a live room, who is viewing, asking Claude, or a page that saves new versions of itself. Load before passing `capabilities` to the Artifact tool or writing any `claude.use(...)` page code.
---

# Artifact capabilities

Claude Code's Artifact tool tells Claude to load this skill. In Pi, the guidance comes live from the artifact service, so it always matches the current runtime contract.

## Read the current contract

Run these from this skill's directory. They use Claude Code's claude.ai login and print nothing secret.

```bash
python3 ../../artifact-api.py prompt            # how each capability works and how to declare it
python3 ../../artifact-api.py defs db           # the typed calls for one capability
python3 ../../artifact-api.py connectors        # this account's claude.ai connectors, by display name
```

Read the `prompt` output before writing page code. It names every capability, its declaration and its failure codes. Read `defs` for each capability the page uses. Both are the service's own text and take precedence over anything remembered.

## Declare and publish

- Pass the declaration as `capabilities` on the Artifact publish, for example `{"db": {}}`. The tool pins the current contract.
- Never declare `permissions`. It is part of the runtime, and the service rejects it.
- On a later publish, omit `capabilities` to keep the stored declaration. Pass the full set to change it, or `{}` to clear it.
- Page code reaches a capability with `await claude.use("<name>")`. It resolves `null` where the view cannot run it, so the page must render without it.

## Connectors

A page can call only remote connectors that each viewer has connected on claude.ai. Use the exact display name from `connectors` as the server and the connector's exact upstream tool name. Claude Code's server in Pi cannot see claude.ai connectors, so it cannot check tool names for you. Observe the tool once through a connected client, such as the matching Pi MCP server, before relying on its name, input and result shape.

## Check it works

Open the published URL in a browser (the `visual-verify` skill) and use each capability once. Connector calls and asking Claude prompt each viewer for consent on first use, so a test that never answers the prompt has not shown the capability works.
