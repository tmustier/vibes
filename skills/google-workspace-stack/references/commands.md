# Command reference

## Default CLI: `gog`

Use `gog` first for routine tasks.

### Gmail
```bash
gog gmail search "newer_than:7d" --max 10 --json
gog gmail get <messageId> --json
gog gmail send --help
```

### Calendar
```bash
gog calendar list --days 7 --json
gog calendar create primary --title "Intro" --from "2026-03-10 14:00" --to "2026-03-10 14:30"
```

### Drive
```bash
gog drive ls --max 20 --json
gog drive search "pipeline" --json
gog drive upload ./file.pdf --json
```

### Sheets
```bash
gog sheets get <spreadsheetId> 'Sheet1!A1:C10' --json
gog sheets update <spreadsheetId> 'Sheet1!B2' 'Done' --json
gog sheets append <spreadsheetId> 'Sheet1!A1' 'Alice' '42' --json
```

### Docs
```bash
gog docs cat <docId>
gog docs update <docId> --content-file ./notes.md --format markdown --append --json
```

### Slides
```bash
gog slides read-slide <presentationId> <slideId> --json
gog slides update-notes <presentationId> <slideId> --content "New notes" --json
```

## Advanced CLI: `gws`

Use `gws` for raw API access. `gwsa` remains as a compatibility alias, but new usage should prefer `gws`.

```bash
# Introspection
gws schema drive.files.list
gws schema sheets.spreadsheets.batchUpdate

# Drive raw API
gws drive files list --params '{"pageSize": 5, "fields": "files(id,name),nextPageToken"}'

# Sheets advanced mutation
gws sheets spreadsheets batchUpdate --params '{"spreadsheetId":"SPREADSHEET_ID"}' --json '{"requests":[...]}'

# Docs advanced mutation
gws docs documents batchUpdate --params '{"documentId":"DOC_ID"}' --json '{"requests":[...]}'

# Slides advanced mutation
gws slides presentations batchUpdate --params '{"presentationId":"PRESENTATION_ID"}' --json '{"requests":[...]}'
```

## Maintenance

```bash
# Rebuild and reinstall command links from the pinned vendor ref
./scripts/sync-googleworkspace-cli.sh

# Run preflight checks
./scripts/doctor.sh

# Run non-destructive smoke tests
./scripts/smoke-test.sh
```
