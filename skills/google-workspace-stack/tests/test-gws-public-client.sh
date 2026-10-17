#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/cache"
CREDENTIALS="$TMP_DIR/credentials.json"
RAW_GWS="$TMP_DIR/raw-gws"
printf '%s\n' '{"client_id":"public-client-id"}' > "$CREDENTIALS"

cat > "$TMP_DIR/bin/gog" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "status --json" ]]; then
  jq -n --arg path "$FAKE_CREDENTIALS" '{account:{email:"agent@example.test",credentials_path:$path}}'
elif [[ "$1 $2 $3" == "auth tokens export" ]]; then
  output=""
  while [[ $# -gt 0 ]]; do
    [[ "$1" == "--out" ]] && output="$2" && shift 2 || shift
  done
  printf '%s\n' '{"refresh_token":"refresh-token","access_token":"access-token","access_token_expires_at":"2999-01-01T00:00:00Z"}' > "$output"
else
  echo "unexpected gog invocation: $*" >&2
  exit 2
fi
SH

cat > "$TMP_DIR/bin/curl" <<'SH'
#!/usr/bin/env bash
echo "curl should not run when gog exports a valid access token" >&2
exit 3
SH

cat > "$RAW_GWS" <<'SH'
#!/usr/bin/env bash
[[ "${GOOGLE_WORKSPACE_CLI_TOKEN:-}" == "access-token" ]] || exit 4
printf 'raw-gws %s\n' "$*"
SH
chmod +x "$TMP_DIR/bin/gog" "$TMP_DIR/bin/curl" "$RAW_GWS"

OUTPUT="$(
  PATH="$TMP_DIR/bin:$PATH" \
  HOME="$TMP_DIR/home" \
  XDG_CACHE_HOME="$TMP_DIR/cache" \
  FAKE_CREDENTIALS="$CREDENTIALS" \
  GWSTACK_RAW_GWS_BIN="$RAW_GWS" \
  "$REPO_ROOT/scripts/gws" --no-token-cache version
)"

[[ "$OUTPUT" == "raw-gws version" ]]
echo "public OAuth client test passed"
