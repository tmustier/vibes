# Google Workspace routing matrix

This skill keeps one simple mental model:

- **`gog` first** for common, task-shaped workflows
- **`gws` second** for advanced raw API operations
- **live edits first**, export/import only when explicitly needed

`gwsa` remains as a compatibility alias, but new usage should prefer `gws`.

## Summary

| Service | Default | Escalate to `gws` for |
|---|---|---|
| Gmail | `gog gmail ...` | IMAP/POP/language, CSE/S-MIME, raw import/insert, unusual low-level endpoints |
| Calendar | `gog calendar ...` | `calendarList`, `settings`, watches, recurring instances, quickAdd, raw import/move/patch |
| Drive | `gog drive ...` | changes/watch, revisions, replies, file labels, advanced permissions CRUD, approvals/access proposals |
| Sheets | `gog sheets ...` | `spreadsheets.batchUpdate`, `values.batchUpdate`, structural edits, developer metadata, DataFilter endpoints |
| Docs | `gog docs ...` | raw `documents.batchUpdate` |
| Slides | `gog slides ...` | raw `presentations.batchUpdate`, thumbnails, lower-level page/object edits |

## Coverage notes by service

### Gmail
`gog` already covers most daily workflows well:
- searching inbox and threads
- getting message/thread content
- sending mail and drafts
- labels
- filters / delegates / forwarding / vacation

`gws` adds the more administrative API surface:
- IMAP settings
- POP settings
- language settings
- CSE identities / keypairs
- S-MIME details under send-as
- raw `messages.import` and `messages.insert`
- explicit raw trash/untrash endpoints

### Calendar
`gog` is stronger for day-to-day human workflows:
- search/list events
- create/update/delete
- freebusy
- RSVP
- focus time / OOO / working location
- team and user helpers

`gws` adds more of the raw API model:
- `calendarList.*`
- `settings.*`
- `events.instances`
- `events.quickAdd`
- `events.watch`
- `acl.watch`
- `channels.stop`
- raw `patch`, `move`, `import`

### Drive
`gog` covers most file-management flows:
- list/search/get
- upload/download
- create folders
- rename/move/share/unshare
- comments
- shared drive listing

`gws` adds the long-tail platform surface:
- `about`
- `apps`
- `changes`
- `channels`
- `operations`
- `replies`
- `revisions`
- `files.generateIds`
- `files.emptyTrash`
- `files.listLabels`
- `files.modifyLabels`
- full `permissions.*`
- `accessproposals` / `approvals`

### Sheets
`gog` is enough for simple range work:
- get / update / append / clear
- basic formatting
- notes
- metadata
- create / copy / export

`gws` is where advanced spreadsheet automation lives:
- `spreadsheets.batchUpdate`
- `values.batchUpdate`
- `values.batchGet`
- DataFilter endpoints
- developer metadata
- sheet copy-to
- multi-request structural and formatting changes

### Docs
`gog` is actually the more ergonomic default:
- create / copy / export
- read text
- write / insert / delete / update
- find-replace
- comments

Use `gws` mainly for raw `documents.batchUpdate` request sequences.

### Slides
`gog` is the more useful authoring tool:
- create / copy / export
- create from markdown
- add / replace slides
- list slides
- read slide content
- update notes

Use `gws` when you specifically need:
- `presentations.batchUpdate`
- `pages.getThumbnail`
- low-level page/object manipulation

## Preferred operational style

### Good default
1. Read current state.
2. Make the smallest live API edit that solves the task.
3. Re-read to verify.

### Avoid by default
1. Export Google file.
2. Edit offline.
3. Re-upload / convert back.

That offline loop should be reserved for explicit file deliverables or tooling constraints.
