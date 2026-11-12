#!/bin/bash
# The nightly job is created when missing and reloaded when unloaded, never rewritten, and an
# offline update leaves the last result alone.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/home & spaces" PI_CODING_AGENT_DIR="$scratch/agent"
source scripts/vibes
LAUNCH_AGENTS=$scratch/agents
LOG_FILE="$HOME/log & spaces"
launchctl() { echo "$1" >>"$scratch/launchctl"; [ "$1" != print ] || [ -e "$scratch/loaded" ]; }

install_update_job
python3 - "$LAUNCH_AGENTS/$UPDATE_LABEL.plist" "$HOME/.local/bin/vibes" "$LOG_FILE" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f: p = plistlib.load(f)
assert p['Label'] == 'ai.vibes.pi-update'
assert p['ProgramArguments'] == [sys.argv[2], 'update']
assert p['StartCalendarInterval'] == {'Hour': 4, 'Minute': 4}
assert p['StandardOutPath'] == p['StandardErrorPath'] == sys.argv[3]
PY
[ "$(tr '\n' ' ' <"$scratch/launchctl")" = 'print enable bootstrap ' ]
# A user's own plist is loaded as it is, never rewritten.
printf 'custom\n' >"$LAUNCH_AGENTS/$UPDATE_LABEL.plist"
: >"$scratch/launchctl"
install_update_job
[ "$(cat "$LAUNCH_AGENTS/$UPDATE_LABEL.plist")" = custom ]
[ "$(tr '\n' ' ' <"$scratch/launchctl")" = 'print enable bootstrap ' ]
touch "$scratch/loaded"
: >"$scratch/launchctl"
install_update_job
[ "$(cat "$scratch/launchctl")" = print ]

# Offline, a real update run (network denied by the macOS sandbox) stops before doing anything
# and records nothing, so Pi doesn't try to repair a network outage; the hourly refresh retries.
offline="$scratch/offline"
mkdir -p "$offline/home" "$offline/agent"
code=0
sandbox-exec -p '(version 1)(allow default)(deny network-outbound (remote ip))' \
	env HOME="$offline/home" PI_CODING_AGENT_DIR="$offline/agent" scripts/vibes update >/dev/null 2>&1 || code=$?
[ "$code" = 75 ]
[ ! -e "$offline/agent/vibes-update.json" ]
grep -q 'offline; vibes refresh retries hourly' "$offline/home/Library/Logs/pi-update.log"
echo 'ok: nightly job created or loaded but never rewritten; an offline update records nothing'
