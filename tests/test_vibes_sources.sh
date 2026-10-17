#!/bin/bash
# `vibes update` updates exactly the user's entries for Vibes packages, whatever form they take,
# and never a personal package, installed or not (a missing one is reinstalled). Uses the pi on
# PATH (CI installs the pinned version).
set -eu
cd "$(dirname "$0")/.."
export PI_CODING_AGENT_DIR=$(mktemp -d)
trap 'rm -rf "$PI_CODING_AGENT_DIR"' EXIT
for repo in tmustier/vibes tmustier/pi-extensions; do mkdir -p "$PI_CODING_AGENT_DIR/git/github.com/$repo"; done
cat >"$PI_CODING_AGENT_DIR/settings.json" <<'JSON'
{"packages": [
	{"source": "git:github.com/tmustier/vibes@release/test", "extensions": ["!extensions/surf.ts"]},
	"ssh://git@github.com/anthropics/skills",
	"git:github.com/tmustier/pi-extensions"
]}
JSON
expected=$'git:github.com/tmustier/vibes@release/test\nssh://git@github.com/anthropics/skills'
source scripts/vibes
actual=$(node lib/vibes-sources.mjs "$(pi_bin)" settings.template.json)
[ "$actual" = "$expected" ] || { echo "FAIL: got"; echo "$actual"; exit 1; }
tests/test_home_command.sh
echo ok
