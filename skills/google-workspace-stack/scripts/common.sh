#!/usr/bin/env bash

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$COMMON_DIR/.." && pwd)"
LOCK_FILE="${GWSTACK_LOCK_FILE:-$REPO_ROOT/vendor.lock.json}"
VENDOR_DIR="${GWSTACK_VENDOR_DIR:-${HOME}/.pi/vendor/googleworkspace-cli}"
RAW_GWS_BIN="${GWSTACK_RAW_GWS_BIN:-$VENDOR_DIR/target/release/gws}"
BIN_DIR="${GWSTACK_BIN_DIR:-${HOME}/.local/bin}"
CACHE_DIR="${XDG_CACHE_HOME:-${HOME}/.cache}/google-workspace-stack"

log() {
  printf '%s\n' "$*" >&2
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "missing required command: $cmd"
    return 1
  fi
}

ensure_dir_secure() {
  local dir="$1"
  mkdir -p "$dir"
  chmod 700 "$dir" 2>/dev/null || true
}

locked_repo_url() {
  jq -r '.googleworkspace_cli.repo_url' "$LOCK_FILE"
}

locked_ref() {
  jq -r '.googleworkspace_cli.ref' "$LOCK_FILE"
}

locked_commit() {
  jq -r '.googleworkspace_cli.commit' "$LOCK_FILE"
}

locked_version() {
  jq -r '.googleworkspace_cli.version' "$LOCK_FILE"
}

update_lock_file() {
  local ref="$1"
  local commit="$2"
  local version="$3"
  python3 - "$LOCK_FILE" "$ref" "$commit" "$version" <<'PY'
import json, sys
path, ref, commit, version = sys.argv[1:5]
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
data['googleworkspace_cli']['ref'] = ref
data['googleworkspace_cli']['commit'] = commit
data['googleworkspace_cli']['version'] = version
with open(path, 'w', encoding='utf-8') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
PY
}

resolve_account_cache_key() {
  local account="$1"
  python3 - "$account" <<'PY'
import re, sys
print(re.sub(r'[^A-Za-z0-9._-]', '_', sys.argv[1]))
PY
}
