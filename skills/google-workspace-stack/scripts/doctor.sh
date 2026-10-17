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

FAILURES=0
WARNINGS=0

pass() { printf 'PASS: %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf 'FAIL: %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

check_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "command available: $cmd ($(command -v "$cmd"))"
  else
    fail "missing command: $cmd"
  fi
}

check_cmd gog
check_cmd jq
check_cmd curl
check_cmd python3
check_cmd git
check_cmd cargo

GOG_MIN_VERSION="0.34.0"
GOG_VERSION="$(gog --version 2>/dev/null | sed -E 's/^v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/' || true)"
if python3 - "$GOG_VERSION" "$GOG_MIN_VERSION" <<'PY'
import sys
try:
    current = tuple(map(int, sys.argv[1].split(".")))
    minimum = tuple(map(int, sys.argv[2].split(".")))
    raise SystemExit(0 if current >= minimum else 1)
except ValueError:
    raise SystemExit(1)
PY
then
  pass "gog version supported: $GOG_VERSION"
else
  fail "gog $GOG_MIN_VERSION or newer required (found ${GOG_VERSION:-unknown})"
fi

if [[ -f "$LOCK_FILE" ]]; then
  pass "lock file present: $LOCK_FILE"
  pass "locked gws ref: $(locked_ref) @ $(locked_commit)"
else
  fail "lock file missing: $LOCK_FILE"
fi

if [[ -d "$VENDOR_DIR" ]]; then
  pass "vendor repo present: $VENDOR_DIR"
else
  fail "vendor repo missing: $VENDOR_DIR"
fi

if [[ -x "$RAW_GWS_BIN" ]]; then
  pass "raw gws binary present: $RAW_GWS_BIN"
else
  fail "raw gws binary missing: $RAW_GWS_BIN"
fi

if command -v gws >/dev/null 2>&1; then
  pass "gws is on PATH ($(command -v gws))"
else
  fail "gws is not on PATH; run $REPO_ROOT/scripts/sync-googleworkspace-cli.sh"
fi

if command -v gws-raw >/dev/null 2>&1; then
  pass "gws-raw is on PATH ($(command -v gws-raw))"
else
  warn "gws-raw is not on PATH"
fi

GOG_STATUS_JSON="$(gog status --json 2>/dev/null || true)"
ACCOUNT="$(printf '%s' "$GOG_STATUS_JSON" | jq -r '.account.email // empty')"
CREDENTIALS_EXISTS="$(printf '%s' "$GOG_STATUS_JSON" | jq -r '.account.credentials_exists // false')"

if [[ -n "$ACCOUNT" ]]; then
  pass "gog account detected: $ACCOUNT"
else
  fail "no gog account detected"
fi

if [[ "$CREDENTIALS_EXISTS" == "true" ]]; then
  pass "gog client credentials present"
else
  fail "gog client credentials missing"
fi

if "$REPO_ROOT/scripts/gws" version >/dev/null 2>&1; then
  pass "authenticated gws wrapper runs"
else
  fail "authenticated gws wrapper failed to run"
fi

if "$REPO_ROOT/scripts/gws" schema drive.files.list >/dev/null 2>&1; then
  pass "gws schema lookup works"
else
  fail "gws schema lookup failed"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  printf '\nDoctor found %d failure(s) and %d warning(s).\n' "$FAILURES" "$WARNINGS"
  exit 1
fi

printf '\nDoctor passed with %d warning(s).\n' "$WARNINGS"
