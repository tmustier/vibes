#!/usr/bin/env bash
set -euo pipefail

SOURCE_PATH="${BASH_SOURCE[0]}"
while [[ -h "$SOURCE_PATH" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
  LINK_TARGET="$(readlink "$SOURCE_PATH")"
  if [[ "$LINK_TARGET" != /* ]]; then
    SOURCE_PATH="$SOURCE_DIR/$LINK_TARGET"
  else
    SOURCE_PATH="$LINK_TARGET"
  fi
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE_PATH")" && pwd)"
# shellcheck source=./common.sh
source "$SCRIPT_DIR/common.sh"

GWS="$REPO_ROOT/scripts/gws"
TMP_DIR="$(mktemp -d "$CACHE_DIR/smoke.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
ensure_dir_secure "$CACHE_DIR"

run() {
  local name="$1"
  shift
  echo "==> $name"
  "$@"
  echo
}

run_optional() {
  local name="$1"
  shift
  local stdout_file="$TMP_DIR/stdout.txt"
  local stderr_file="$TMP_DIR/stderr.txt"
  echo "==> $name"
  if "$@" >"$stdout_file" 2>"$stderr_file"; then
    cat "$stdout_file"
    [[ -s "$stderr_file" ]] && cat "$stderr_file" >&2
    echo
    return 0
  fi

  local combined
  combined="$(cat "$stdout_file" "$stderr_file" 2>/dev/null || true)"
  if printf '%s' "$combined" | rg -q 'accessNotConfigured|SERVICE_DISABLED|has not been used in project'; then
    echo "WARN: skipped because the required Google API is not enabled for the current project"
    printf '%s\n' "$combined"
    echo
    return 0
  fi

  printf '%s\n' "$combined"
  echo
  return 1
}

find_drive_item_id() {
  local mime_type="$1"
  "$GWS" drive files list --params "{\"pageSize\":1,\"q\":\"mimeType='${mime_type}' and trashed=false\",\"fields\":\"files(id,name),nextPageToken\",\"includeItemsFromAllDrives\":true,\"supportsAllDrives\":true,\"corpora\":\"allDrives\"}" | jq -r '.files[0].id // empty'
}

ensure_dir_secure "$CACHE_DIR"

run "doctor" "$REPO_ROOT/scripts/doctor.sh"
run "gog version" gog --version
run "gws version" "$GWS" version
run "gws-raw version" "$REPO_ROOT/scripts/gws-raw" version

run "gog gmail search" gog gmail search "newer_than:30d" --max 1 --json
run "gws gmail profile" "$GWS" gmail users getProfile --params '{"userId":"me"}'

run "gog calendar list" gog calendar list --days 1 --max 1 --json
run "gws calendar colors" "$GWS" calendar colors get

run "gog drive list" gog drive ls --max 1 --json
run "gws drive files list" "$GWS" drive files list --params '{"pageSize":1,"fields":"files(id,name),nextPageToken"}'

SHEET_ID="$(find_drive_item_id 'application/vnd.google-apps.spreadsheet')"
if [[ -n "$SHEET_ID" ]]; then
  run_optional "gog sheets metadata" gog sheets metadata "$SHEET_ID" --json
else
  echo "==> gog sheets metadata"
  echo "WARN: no Google Sheets file found; skipping live gog sheets metadata check"
  echo
fi
run "gws schema sheets batchUpdate" "$GWS" schema sheets.spreadsheets.batchUpdate

DOC_ID="$(find_drive_item_id 'application/vnd.google-apps.document')"
if [[ -n "$DOC_ID" ]]; then
  run_optional "gog docs info" gog docs info "$DOC_ID" --json
else
  echo "==> gog docs info"
  echo "WARN: no Google Docs file found; skipping live gog docs info check"
  echo
fi
run "gws schema docs batchUpdate" "$GWS" schema docs.documents.batchUpdate

SLIDES_ID="$(find_drive_item_id 'application/vnd.google-apps.presentation')"
if [[ -n "$SLIDES_ID" ]]; then
  run_optional "gog slides info" gog slides info "$SLIDES_ID" --json
else
  echo "==> gog slides info"
  echo "WARN: no Google Slides file found; skipping live gog slides info check"
  echo
fi
run "gws schema slides batchUpdate" "$GWS" schema slides.presentations.batchUpdate

echo "Smoke test passed"
