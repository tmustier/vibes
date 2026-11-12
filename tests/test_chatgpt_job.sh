#!/bin/bash
# A separate calendar/login/retry job; never rewrite the user's nightly update schedule.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/home & spaces" PI_CODING_AGENT_DIR="$scratch/agent"
source scripts/vibes
LAUNCH_AGENTS=$scratch/agents
LOG_FILE="$HOME/log & spaces"
launchctl() { echo "$1 ${2:-}" >>"$scratch/launchctl"; [ "$1" != print ] || [ -e "$scratch/loaded" ]; }
install_chatgpt_job
python3 - "$LAUNCH_AGENTS/$CHATGPT_LABEL.plist" "$HOME/.local/bin/vibes" "$LOG_FILE" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as stream: p = plistlib.load(stream)
assert p['Label'] == 'ai.vibes.chatgpt-update'
assert p['ProgramArguments'] == [sys.argv[2], 'chatgpt-update']
assert p['StartCalendarInterval'] == [{'Weekday': 6, 'Hour': 3, 'Minute': 50}, {'Weekday': 6, 'Hour': 4, 'Minute': 0}]
assert p['RunAtLoad'] and p['StartInterval'] == 300
assert p['StandardOutPath'] == p['StandardErrorPath'] == sys.argv[3]
PY
[ "$(cut -d' ' -f1 "$scratch/launchctl" | tr '\n' ' ')" = 'print enable bootstrap ' ]
! grep -q 'pi-update' "$scratch/launchctl"
touch "$scratch/loaded"
: >"$scratch/launchctl"
install_chatgpt_job
[ "$(cut -d' ' -f1 "$scratch/launchctl")" = print ]
CHATGPT_INTERVAL_SECONDS=600 install_chatgpt_job
[ "$(tail -3 "$scratch/launchctl" | cut -d' ' -f1 | tr '\n' ' ')" = 'bootout enable bootstrap ' ]
# install-jobs installs the companion even if the nightly agent already exists.
for fn in install_update_job install_hotfix_job install_refresh_job; do eval "$fn() { :; }"; done
install_chatgpt_job() { echo chatgpt-job >>"$scratch/installed"; }
cmd_install_jobs
[ "$(cat "$scratch/installed")" = chatgpt-job ]
# launchd gives the job the system PATH; the updater must still find Homebrew to install a missing ChatGPT.
(
	python3() { printf '%s\n' "$PATH" "$*" >"$scratch/updater"; }
	PATH=/usr/bin:/bin:/usr/sbin:/sbin
	main chatgpt-update --status
)
[ "$(sed -n 1p "$scratch/updater")" = /usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin ]
[ "$(sed -n 2p "$scratch/updater")" = "$VIBES/scripts/chatgpt-update --status" ]
echo 'ok: Saturday 04:00 local, advance warning, login and bounded catch-up ticks'
