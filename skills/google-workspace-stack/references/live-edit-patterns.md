# Live edit patterns for Google Workspace

## Principle

Treat the Google object as the source of truth.

- Read it in place.
- Edit it in place.
- Verify it in place.

Avoid export/import unless the user explicitly wants a local artifact or a local-only tool is required.

## Sheets

### Use `gog` for simple range work
Examples:
- update one cell
- append a few rows
- clear a range
- inspect metadata
- apply a basic format tweak

Pattern:
1. `gog sheets get <spreadsheetId> 'Sheet1!A1:C20' --json`
2. `gog sheets update ...` or `append ...`
3. `gog sheets get ...` again

### Use `gws` for structural or advanced edits
Examples:
- add or rename tabs
- freeze rows
- set widths
- apply conditional formatting
- add dropdowns/data validation
- protect ranges
- build charts or pivots
- make many coordinated edits at once

Pattern:
1. Inspect current spreadsheet or range
2. Build one `batchUpdate` request with all related edits
3. Run `gws sheets spreadsheets batchUpdate ...`
4. Re-read affected areas

## Docs

### Use `gog` for document-like editing
Examples:
- append meeting notes
- replace a placeholder
- insert content at a position
- delete a text range

### Use `gws` when the operation is naturally a Docs API request list
Examples:
- many precise style + structure mutations together
- template expansion with multiple request types
- raw control over Docs API batch requests

## Slides

### Use `gog` for authoring workflows
Examples:
- create a deck
- create from markdown
- add or replace a slide image
- update notes
- inspect slide content

### Use `gws` for lower-level presentation mutations
Examples:
- many page/object edits in one request
- raw object positioning or style updates
- retrieving thumbnails

## Drive

### Use `gog` for file-manager actions
Examples:
- search for a file
- upload or download
- move or rename
- share or unshare
- read or post comments

### Use `gws` for platform-level controls
Examples:
- inspect revisions
- manage replies to comments
- monitor changes
- operate on file labels
- use advanced permissions CRUD

## Calendar

### Use `gog` for meeting workflows
Examples:
- find events
- schedule or edit a meeting
- RSVP
- check freebusy
- create focus time / OOO / working location

### Use `gws` for raw calendar resources
Examples:
- `calendarList`
- `settings`
- `watch`
- recurring `instances`
- quickAdd text parsing

## Gmail

### Use `gog` for mailbox workflows
Examples:
- search threads or messages
- read a message or thread
- send mail or drafts
- work with labels / filters / delegates / forwarding / vacation

### Use `gws` for low-level mailbox admin features
Examples:
- IMAP / POP / language settings
- CSE / S-MIME
- raw message import / insert

## Verification checklist after writes

After changing a live Google object, verify by re-reading the thing you changed:
- edited cells/ranges
- updated event
- renamed/moved/shared file
- changed slide or document content

When possible, mention both:
- what was changed
- how it was verified
