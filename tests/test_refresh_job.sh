#!/bin/bash
# The login/hourly companion never unloads the nightly job or its own running update.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/home & spaces" PI_CODING_AGENT_DIR="$scratch/agent"
source scripts/vibes
LAUNCH_AGENTS=$scratch/agents
LOG_FILE="$HOME/log & spaces"
launchctl() { echo "$1 ${2:-}" >>"$scratch/launchctl"; [ "$1" != print ] || [ -e "$scratch/loaded" ]; }
install_refresh_job
python3 - "$LAUNCH_AGENTS/$REFRESH_LABEL.plist" "$HOME/.local/bin/vibes" "$LOG_FILE" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f: p = plistlib.load(f)
assert p['Label'] == 'ai.vibes.pi-refresh'
assert p['ProgramArguments'] == [sys.argv[2], 'refresh']
assert p['RunAtLoad'] is True and p['StartInterval'] == 3600
assert p['StandardOutPath'] == p['StandardErrorPath'] == sys.argv[3]
PY
[ "$(cut -d' ' -f1 "$scratch/launchctl" | tr '\n' ' ')" = 'print bootstrap ' ]
! grep -q 'pi-update' "$scratch/launchctl"
touch "$scratch/loaded"
: >"$scratch/launchctl"
install_refresh_job
[ "$(cut -d' ' -f1 "$scratch/launchctl")" = print ]
# A future schedule change during a catch-up run must not kill that run or hide the pending change.
REFRESH_INTERVAL_SECONDS=7200 VIBES_REFRESH_JOB=1 install_refresh_job
[ "$(plutil -extract StartInterval raw "$LAUNCH_AGENTS/$REFRESH_LABEL.plist")" = 3600 ]
REFRESH_INTERVAL_SECONDS=7200 install_refresh_job
[ "$(plutil -extract StartInterval raw "$LAUNCH_AGENTS/$REFRESH_LABEL.plist")" = 7200 ]
[ "$(tail -2 "$scratch/launchctl" | cut -d' ' -f1 | tr '\n' ' ')" = 'bootout bootstrap ' ]
echo 'ok: login/hourly catch-up job, escaped paths, no nightly unload, safe self-update'
