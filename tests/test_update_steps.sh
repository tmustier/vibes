#!/bin/bash
# The update lock, Node checks and log of `vibes update`.
set -u
cd "$(dirname "$0")/.."
source scripts/vibes
scratch=$(mktemp -d)
export PI_CODING_AGENT_DIR=$scratch/agent
mkdir -p "$PI_CODING_AGENT_DIR"
trap 'pkill -f "$scratch/" 2>/dev/null; rm -rf "$scratch"' EXIT
failures=0
check() { if eval "$2"; then :; else echo "FAIL: $1"; failures=$((failures + 1)); fi; }
LOCK_FILE=$scratch/lock
# Test processes are scripts in $scratch, so matching their path finds only this test's processes.
printf '#!/bin/bash\nsleep "$1"\n' >"$scratch/leaf"
printf '#!/bin/bash\n"%s/leaf" "$1" &\nwait\n' "$scratch" >"$scratch/work"
chmod +x "$scratch/leaf" "$scratch/work"
holder() { pgrep -f "^/usr/bin/perl -MFcntl.* $scratch/lock" | head -1; }
running() { pgrep -f "$scratch/(work|leaf)" >/dev/null; }
stop_leftovers() { pkill -f "$scratch/(work|leaf)" 2>/dev/null; sleep 0.2; }
lock_race() {
	rm -f "$scratch"/race.*
	for i in $(seq 1 20); do ( (with_lock "$scratch/work" 2) >/dev/null; echo $? >"$scratch/race.$i") & done
	wait
	[ "$(grep -lx 0 "$scratch"/race.* | wc -l | tr -d " ")" = 1 ] && [ "$(grep -lx 75 "$scratch"/race.* | wc -l | tr -d " ")" = 19 ]
}

# One update at a time: a second run stops at once.
(with_lock "$scratch/work" 5) &
sleep 1
(with_lock true) >/dev/null
check "second run refused while the first holds the lock" '[ $? -eq 75 ]'
# A run killed outright leaves no stale lock.
kill -9 "$(holder)"
wait 2>/dev/null
(with_lock true)
check "lock free after its holder is killed" '[ $? -eq 0 ]'
stop_leftovers
# Many runs starting together: exactly one runs.
check "exactly one of 20 simultaneous runs" lock_race
# ...also right after a run was killed, when an old-style lock would look stale to all of them.
(with_lock "$scratch/work" 5) &
sleep 1
kill -9 "$(holder)"
wait 2>/dev/null
stop_leftovers
check "exactly one of 20 simultaneous runs after a crash" lock_race
# Stopping the run (launchd sends TERM to the process it started) stops the update and everything
# it started, and frees the lock.
(with_lock "$scratch/work" 30) &
sleep 1
kill -TERM "$(holder)"
wait $!
check "TERM stops the update" '[ $? -eq 143 ] && sleep 0.5 && ! running'
(with_lock true)
check "lock free after TERM" '[ $? -eq 0 ]'
# The command reports its own exit status.
(with_lock bash -c 'exit 3')
check "exit status passed through" '[ $? -eq 3 ]'
# `vibes update` itself becomes the lock holder, so launchd's TERM reaches it.
mkdir -p "$scratch/fake/scripts" && printf '#!/bin/bash\n"%s/work" 30\n' "$scratch" >"$scratch/fake/scripts/vibes" && chmod +x "$scratch/fake/scripts/vibes"
VIBES_UPDATE_LOCKED= bash -c 'source scripts/vibes; LOCK_FILE=$1; VIBES=$2; cmd_update' _ "$scratch/lock" "$scratch/fake" 2>/dev/null &
update=$!
sleep 1
check "vibes update runs as the lock holder" '[ "$(holder)" = "$update" ]'
kill -TERM "$update"
wait "$update"
check "TERM to vibes update stops it" '[ $? -eq 143 ] && sleep 0.5 && ! running'

# After the packages step, the update carries on in the script that step installed, handing over
# the steps so far and the previous templates, in the same process (so it keeps the lock).
mkdir -p "$scratch/handover/scripts"
cp scripts/refresh "$scratch/handover/scripts/refresh"
printf '{"toolActivation":"eager"}\n' >"$scratch/handover/web-search.template.json"
(
	source scripts/vibes
	VIBES=$scratch/handover LOG_FILE=$scratch/handover-log VIBES_UPDATE_LOCKED=1
	for f in update_brew update_nvm update_node load_nvm npm latest_hotfix; do eval "$f() { :; }"; done
	node() { echo v0; }
	update_vibes_packages() {
		printf '#!/bin/bash\n{ echo "$$"; echo "$VIBES_UPDATE_CONTINUED"; echo "$VIBES_UPDATE_PREVIOUS"; printf "%%s" "$VIBES_UPDATE_RESULTS"; } >"%s/handover/got"\n' "$scratch" >"$VIBES/scripts/vibes"
		chmod +x "$VIBES/scripts/vibes"
		sh -c 'echo $PPID' >"$scratch/handover/pid"
	}
	cmd_update
) >/dev/null 2>&1
check "handover: runs the new script in the same process" '[ "$(sed -n 1p "$scratch/handover/got")" = "$(cat "$scratch/handover/pid")" ] && [ "$(sed -n 2p "$scratch/handover/got")" = 1 ]'
check "handover: passes the previous templates" '[ -d "$(sed -n 3p "$scratch/handover/got")" ]'
check "handover: snapshots the web activation template" 'cmp -s "$scratch/handover/web-search.template.json" "$(sed -n 3p "$scratch/handover/got")/web-search.template.json"'
check "handover: passes the steps so far" '[ "$(sed -n "4,\$p" "$scratch/handover/got" | cut -f1,2 | tr "\t\n" ": ")" = "homebrew:ok nvm:ok node:ok npm:ok packages:ok " ]'
rm -rf "$(sed -n 3p "$scratch/handover/got")"
# The new script picks up from there and records every step.
previous=$(mktemp -d)
(
	source scripts/vibes
	VIBES=$scratch/handover LOG_FILE=$scratch/handover-log STATUS_FILE=$scratch/status.json NOTES_FILE=$scratch/notes VIBES_UPDATE_LOCKED=1
	for f in load_nvm refresh_rolling_packages sync_settings install_pinned_pi install_hotfix_job install_refresh_job update_repo cmd_check osascript; do eval "$f() { :; }"; done
	mkdir -p "$VIBES/scripts" && printf '#!/bin/bash\n' >"$VIBES/scripts/inventory" && chmod +x "$VIBES/scripts/inventory"
	cp "$VIBES/scripts/inventory" "$VIBES/scripts/usage-telemetry"
	export VIBES_UPDATE_CONTINUED=1 VIBES_UPDATE_PREVIOUS=$previous VIBES_UPDATE_RESULTS=$'homebrew\tok\t\nnpm\tfail\texit 1\n'
	cmd_update
) >/dev/null 2>&1
check "continued: records the handed-over and new steps" '[ "$(node -e "const s=require(process.argv[1]);console.log(s.steps.map(x=>x.name+(x.ok?\"\":\"!\")).join(\" \"))" "$scratch/status.json")" = "homebrew npm! rolling-packages settings pi hotfix-job refresh-job startup telemetry usage-telemetry" ]'
rm -rf "$previous"

# The first update to the Pi 1.0 pin captures the MCP baseline before Pi moves and runs the migration
# agent after the startup check. A verified laptop never repeats it.
mkdir -p "$scratch/migration/scripts"
cp scripts/refresh "$scratch/migration/scripts/refresh"
printf '{"devDependencies":{"@earendil-works/pi-coding-agent":"1.0.0"}}\n' >"$scratch/migration/package.json"
printf 'template\n' >"$scratch/migration/AGENTS.template.md"
printf '#!/bin/bash\n' >"$scratch/migration/scripts/inventory"
chmod +x "$scratch/migration/scripts/inventory"
cp "$scratch/migration/scripts/inventory" "$scratch/migration/scripts/usage-telemetry"
migration_update() {
	(
		source scripts/vibes
		VIBES=$scratch/migration LOG_FILE=$scratch/migration-log STATUS_FILE=$scratch/migration-status.json NOTES_FILE=$scratch/migration-notes VIBES_UPDATE_LOCKED=1 PI_1_MARKER=$scratch/migration-marker
		for f in load_nvm refresh_rolling_packages sync_settings install_pinned_pi install_hotfix_job install_refresh_job update_repo cmd_check osascript capture_pi_1_baseline; do eval "$f() { :; }"; done
		run_pi_1_migration() { touch "$PI_1_MARKER"; }
		export VIBES_UPDATE_CONTINUED=1 VIBES_UPDATE_PREVIOUS=$(mktemp -d) VIBES_UPDATE_RESULTS=$'packages\tok\t\n'
		cmd_update
	) >/dev/null 2>&1
	node -e "const s=require(process.argv[1]); console.log(s.steps.map(x=>x.name).join(' '))" "$scratch/migration-status.json"
}
check "first 1.0 update: baseline before Pi moves, migration after the startup check" '[ "$(migration_update)" = "packages rolling-packages settings mcp-before pi hotfix-job refresh-job startup pi-1-migration telemetry usage-telemetry" ]'
check "verified laptop: no migration steps" '[ "$(migration_update)" = "packages rolling-packages settings pi hotfix-job refresh-job startup telemetry usage-telemetry" ]'

# Upload-only failures keep the installation successful, but retain a nonzero command exit.
printf '#!/bin/bash\nexit 1\n' >"$scratch/migration/scripts/usage-telemetry"
pending_update() {
	(
		source scripts/vibes
		VIBES=$scratch/migration LOG_FILE=$scratch/pending-log STATUS_FILE=$PI_CODING_AGENT_DIR/vibes-update.json NOTES_FILE=$scratch/pending-notes VIBES_UPDATE_LOCKED=1
		for f in load_nvm refresh_rolling_packages sync_settings install_pinned_pi install_hotfix_job install_refresh_job update_repo; do eval "$f() { :; }"; done
		pi_1_migration_needed() { return 1; }
		cmd_check() { printf '{}\n' >"$INVENTORY"; return "$startup_code"; }
		osascript() { echo notification >>"$scratch/notifications"; }
		export VIBES_UPDATE_CONTINUED=1 VIBES_UPDATE_PREVIOUS=$(mktemp -d) VIBES_UPDATE_RESULTS=$'homebrew\tok\t\n'
		cmd_update
	) >"$scratch/pending-output" 2>&1
}
startup_code=0
pending_update
check "upload failure: command still fails" '[ $? -eq 1 ]'
check "upload failure: installation succeeded, upload failed, template recorded" 'node -e "const s=require(process.argv[1]); process.exit(s.ok && s.agentsTemplateHash && s.steps.find(x=>x.name===\"usage-telemetry\").ok===false ? 0 : 1)" "$PI_CODING_AGENT_DIR/vibes-update.json"'
check "upload failure: hourly guidance, no failed-install notification" 'grep -q "Update succeeded; telemetry upload pending.*hourly.*vibes refresh" "$scratch/pending-output" && [ ! -e "$scratch/notifications" ]'
startup_code=1
pending_update
check "mixed failure: command fails" '[ $? -eq 1 ]'
check "mixed failure: installation failed, notification retained" 'node -e "process.exit(require(process.argv[1]).ok ? 1 : 0)" "$PI_CODING_AGENT_DIR/vibes-update.json" && [ -s "$scratch/notifications" ]'

# Without nvm, Node can't be kept at the team's version: those steps fail rather than pass.
(NVM_DIR=$scratch/no-nvm; unset -f nvm; update_nvm >/dev/null)
check "missing nvm fails the nvm step" '[ $? -ne 0 ]'
(unset -f nvm; PATH=/usr/bin:/bin; update_node >/dev/null)
check "missing nvm fails the node step" '[ $? -ne 0 ]'
# nvm that leaves another major version in use fails the node step.
(
	nvm() { case $1 in version-remote) echo v26.1.0 ;; version) echo v26.1.0 ;; *) return 0 ;; esac; }
	node() { [ "$1" = -p ] && echo 22 || echo v22.0.0; }
	update_node >/dev/null
)
check "wrong Node major fails the node step" '[ $? -ne 0 ]'

# A run by hand prints and logs; under launchd (output already going to the log) it logs once.
LOG_FILE=$scratch/log
out=$( (log_output; echo by-hand) 2>&1)
sleep 0.5
check "by hand: printed and logged" '[ "$out" = by-hand ] && grep -qx by-hand "$LOG_FILE"'
(exec >>"$LOG_FILE" 2>&1; log_output; echo launchd)
sleep 0.5
check "launchd: logged once" '[ "$(grep -cx launchd "$LOG_FILE")" = 1 ]'

[ $failures -eq 0 ] && echo ok || exit 1
