---
name: google-workspace-stack
description: Route Google Workspace work across Gmail, Calendar, Drive, Sheets, Docs, and Slides. Use when the user asks to work with a live Google Workspace object, a Google link or file ID, or any Gmail/Calendar/Drive/Sheets/Docs/Slides task. Prefer gog for routine work and gws for advanced raw API operations.
---

# Google Workspace Stack

Use a simple two-layer stack:

1. **Default to `gog`** for routine Gmail, Calendar, Drive, Sheets, Docs, and Slides work.
2. **Escalate to `gws`** when the task needs raw Google Workspace API surface that `gog` does not expose cleanly.

`gws` here is a local authenticated wrapper around the vendored Google Workspace CLI. It reuses the user's existing `gog` credentials, so it should work without a separate `gws auth login` flow.

## Core rules

### 1) Edit live Google objects in place
Prefer direct API edits to the existing Google object.

- **Do not export and re-import by default.**
- Export only when the user explicitly wants an offline file (`.xlsx`, `.docx`, `.pptx`, `.pdf`, `.csv`) or when a local-only tool is genuinely required.

### 2) Prefer `gog` unless you need a specific advanced capability
Reach for `gws` when you need things like:
- Sheets, Docs, or Slides `batchUpdate`
- Calendar `calendarList`, `settings`, `watch`, recurring `instances`, `quickAdd`
- Drive `changes`, `revisions`, `replies`, `file labels`, `permissions.*`, `watch`
- Gmail IMAP/POP/language settings, CSE/S-MIME, `import`/`insert`

### 3) Verify after writes
After modifying a live Google object:
- re-read the affected range or object
- confirm the expected state
- report what changed

## Service routing

- **Gmail:** `gog` for search/read/send/drafts/labels/settings; `gws` for IMAP/POP/language, CSE/S-MIME, raw import/insert.
- **Calendar:** `gog` for meetings and schedule work; `gws` for `calendarList`, `settings`, watches, recurring instances, quickAdd, raw patch/import/move.
- **Drive:** `gog` for file-manager tasks; `gws` for revisions, replies, changes/watch, labels, advanced permissions, approvals/access proposals.
- **Sheets:** `gog` for simple range reads/writes; `gws` for `spreadsheets.batchUpdate`, multi-range edits, developer metadata, and DataFilter endpoints.
- **Docs:** `gog` for document editing; `gws` for raw `documents.batchUpdate`.
- **Slides:** `gog` for authoring flows; `gws` for raw `presentations.batchUpdate` and thumbnails.

## Quick references

Read these when you need more detail:
- `references/routing-matrix.md`
- `references/live-edit-patterns.md`
- `references/commands.md`

## Maintenance

Useful commands:

```bash
# Rebuild from the pinned upstream ref and refresh PATH links
./scripts/sync-googleworkspace-cli.sh

# Preflight checks
./scripts/doctor.sh

# Non-destructive smoke tests
./scripts/smoke-test.sh
```

## Vendored upstream reference

The upstream Google Workspace CLI repo is vendored outside this repo at:
`~/.pi/vendor/googleworkspace-cli`

Use its README, docs, and bundled skills as reference material when you need raw API examples or upstream helper behavior.
