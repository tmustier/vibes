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

require_cmd git
require_cmd jq
require_cmd cargo
require_cmd python3

if [[ ! -f "$LOCK_FILE" ]]; then
  log "sync-googleworkspace-cli: lock file not found at $LOCK_FILE"
  exit 1
fi

REPO_URL="$(locked_repo_url)"
REF="${1:-$(locked_ref)}"

mkdir -p "$(dirname "$VENDOR_DIR")"

if [[ ! -d "$VENDOR_DIR/.git" ]]; then
  git clone "$REPO_URL" "$VENDOR_DIR"
fi

cd "$VENDOR_DIR"
git fetch --tags origin

if git ls-remote --exit-code --heads origin "$REF" >/dev/null 2>&1; then
  git checkout "$REF"
  git pull --ff-only origin "$REF"
else
  git checkout --detach "$REF"
fi

cargo build --release

COMMIT="$(git rev-parse HEAD)"
VERSION="$(jq -r '.version // "unknown"' package.json)"
update_lock_file "$REF" "$COMMIT" "$VERSION"

mkdir -p "$BIN_DIR"
ln -sf "$REPO_ROOT/scripts/gws" "$BIN_DIR/gws"
ln -sf "$REPO_ROOT/scripts/gws-raw" "$BIN_DIR/gws-raw"
ln -sf "$REPO_ROOT/scripts/gwsa" "$BIN_DIR/gwsa"

printf 'Vendored repo: %s\n' "$VENDOR_DIR"
printf 'Locked ref: %s\n' "$REF"
printf 'Commit: %s\n' "$COMMIT"
printf 'Version: %s\n' "$VERSION"
printf 'Raw binary: %s\n' "$RAW_GWS_BIN"
printf 'Installed links: %s %s %s\n' "$BIN_DIR/gws" "$BIN_DIR/gws-raw" "$BIN_DIR/gwsa"
