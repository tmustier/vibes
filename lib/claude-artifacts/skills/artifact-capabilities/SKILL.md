---
name: artifact-capabilities
description: Runtime capabilities a published Claude artifact can be granted, such as live claude.ai connector data, a shared database, uploaded files, downloads, a live room, who is viewing, asking Claude, a page that saves new versions of itself, or installing it as a Mac or Windows desktop app with notifications, a menu bar item, global shortcuts, floating windows or file and command access. Load before passing `capabilities` to the Artifact tool, writing any `claude.use(...)` page code, or building a desktop app, menu bar app or widget as an artifact.
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
- Declare `artifact` only when the page must save new versions of itself. In testing (Claude Code 2.1.314, November 2026), Claude Code refused every later publish of a page that declared it, even with `force: true`. Pages without it republished normally. To change such a page, publish a new artifact and tell the user.

## Connectors

A page can call only remote connectors that each viewer has connected on claude.ai. `connectors` lists every connector configured on the account, including ones that still need signing in or that fail, so it does not show that a connector works. When the consent prompt offers Connect or says it couldn't reach the connector's server, the user connects or reconnects it in the Claude desktop app under Customize, then Connectors. The Connect button inside an installed app's prompt did nothing in testing. Use the exact display name from `connectors` as the server and the connector's exact upstream tool name. Claude Code's server in Pi cannot see claude.ai connectors, so it cannot check tool names for you. Observe the tool once through a connected client, such as the matching Pi MCP server, before relying on its name, input and result shape.

## Desktop apps

When the user wants a desktop app, a menu bar app, a floating widget, notifications, or a page that reads their files or runs commands, build an ordinary artifact with the `desktop` capability: read `prompt` and `defs desktop` first. The user installs it from the Claude desktop app. After publishing, call Artifact with `action: "open"`: Pi opens it in the Claude desktop app, or opens the app itself once installed, and its result says what the user does next. Tell the user that the app asks for each permission the first time it uses it, and again after every new published version.

In testing with Claude desktop app 7.37095.0 (contract 0.2.99), these worked in the browser but not inside the Claude desktop app, either in its panel or in the installed app: `tts` resolved `null`, `dictation` resolved `null`, and `assets.upload` never resolved. Do not build a desktop app that depends on them.

Check `permissions.state()` before relying on full access (files, commands, terminals). In that desktop version, flag `3574866070` was off despite managed policy allowing full access. Calls rejected with `ENOSYS` ("Your organization doesn't allow full access for apps") and `full-access` was `unavailable`. macOS Full Disk Access did not fix it. With the user's approval, temporarily setting the flag's `on/value` to `true` and `off` to `false` through the main-process debugger enabled an installed test app to read a disposable file, with permission `granted`. Restoring the flag made the same read fail again. This verifies a local workaround for file reads, not commands, terminals or a persistent override. For an approved test, save and restore the original flag and close the debugger afterwards. The source of the original override is unknown; do not say only Anthropic can enable it.

## Check it works

Open the published URL in a browser (the `visual-verify` skill) and use each capability once. Connector calls and asking Claude prompt each viewer for consent on first use, so a test that never answers the prompt has not shown the capability works.
