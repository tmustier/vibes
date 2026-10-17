#!/bin/bash
# `vibes hotfix-check`: applies a new hotfix tag once, waits while Pi runs if the hotfix moves Pi,
# keeps retrying after a failure, and installs its hourly launchd job.
set -u
cd "$(dirname "$0")/.."
repo=$PWD
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
failures=0
check() { if eval "$2"; then :; else echo "FAIL: $1"; failures=$((failures + 1)); fi; }

# A Vibes remote and the installed checkout of it. cmd_hotfix_check resets PATH to the usual
# places, so node goes in ~/.local/bin of a scratch home.
export HOME=$scratch/home
mkdir -p "$HOME/.local/bin" "$HOME/.pi/agent"
ln -s "$(command -v node)" "$HOME/.local/bin/node"
git init -q --bare "$scratch/origin.git"
git clone -q "$scratch/origin.git" "$scratch/work" 2>/dev/null
cd "$scratch/work"
git config user.email test@example.com && git config user.name test
pin() { printf '{"devDependencies": {"@earendil-works/pi-coding-agent": "%s"}}\n' "$1" >package.json; }
pin 1.0.0 && echo '{}' >settings.template.json && echo '{}' >subagent-config.template.json
git add -A && git commit -qm base && git push -q origin HEAD:main 2>/dev/null
hotfix() { git tag -a "$1" -m "$2" && git push -q origin "$1" 2>/dev/null; }
git clone -q "$scratch/origin.git" "$scratch/vibes" 2>/dev/null
cd "$repo"

run() {
	(
		source scripts/vibes
		VIBES=$scratch/vibes LOCK_FILE=$scratch/lock LOG_FILE=$scratch/log
		export VIBES_UPDATE_LOCKED=1
		update_vibes_packages() { echo packages >>"$scratch/calls"; git -C "$VIBES" pull -q origin main 2>/dev/null; }
		refresh_rolling_packages() { echo rolling-packages >>"$scratch/calls"; [ ! -e "$scratch/rolling-fails" ]; }
		sync_settings() { echo settings >>"$scratch/calls"; }
		install_pinned_pi() { echo pi >>"$scratch/calls"; }
		cmd_check() { echo startup >>"$scratch/calls"; [ ! -e "$scratch/startup-fails" ]; }
		capture_pi_1_baseline() { echo mcp-before >>"$scratch/calls"; }
		run_pi_1_migration() { echo pi-1-migration >>"$scratch/calls"; touch "$PI_1_MARKER"; }
		pi_bin() { echo "$scratch/pi"; }
		pi_running() { [ -e "$scratch/pi-running" ]; }
		osascript() { :; }
		cmd_hotfix_check
	) >/dev/null 2>&1
}
printf '#!/bin/bash\necho 1.0.0\n' >"$scratch/pi" && chmod +x "$scratch/pi"
calls() { cat "$scratch/calls" 2>/dev/null | tr '\n' ' '; }
applied() { cat "$HOME/.pi/agent/vibes-hotfix" 2>/dev/null; }

run
check "no hotfix tags: nothing runs" '[ -z "$(calls)" ] && [ ! -e "$scratch/log" ]'

(cd "$scratch/work" && hotfix hotfix-20260101-000000 "Fix the MCP login")
run
check "new hotfix: the narrow update runs migration once" '[ "$(calls)" = "packages rolling-packages settings mcp-before pi startup pi-1-migration " ]'
check "new hotfix: recorded" '[ "$(applied)" = hotfix-20260101-000000 ]'
check "new hotfix: the user is told what it fixes" 'grep -q "Fix the MCP login. Restart Pi" "$HOME/.pi/agent/vibes-update.json"'
rm -f "$scratch/calls"
run
check "same hotfix again: nothing runs" '[ -z "$(calls)" ]'

# A hotfix that moves Pi waits while Pi is running, and installs once it isn't.
(cd "$scratch/work" && pin 2.0.0 && git commit -qam "Pi 2" && git push -q origin HEAD:main 2>/dev/null && hotfix hotfix-20260102-000000 "Pi 2")
touch "$scratch/pi-running"
run
check "Pi-moving hotfix while Pi runs: waits" '[ -z "$(calls)" ] && [ "$(applied)" = hotfix-20260101-000000 ]'
check "Pi-moving hotfix while Pi runs: remembers it is waiting" '[ "$(cat "$HOME/.pi/agent/vibes-hotfix-waiting")" = hotfix-20260102-000000 ]'
rm -f "$scratch/pi-running"
run
check "Pi closed: the hotfix installs" '[ "$(calls)" = "packages rolling-packages settings pi startup " ] && [ "$(applied)" = hotfix-20260102-000000 ]'
check "installed: no longer waiting" '[ ! -e "$HOME/.pi/agent/vibes-hotfix-waiting" ]'

# A failed hotfix isn't recorded, so the next hour tries again, and Pi reports the failure.
rm -f "$scratch/calls"
printf '#!/bin/bash\necho 2.0.0\n' >"$scratch/pi"
(cd "$scratch/work" && hotfix hotfix-20260103-000000 "Another fix")
touch "$scratch/startup-fails"
run
check "failed hotfix: not recorded" '[ "$(applied)" = hotfix-20260102-000000 ]'
check "failed hotfix: status says it failed" 'node -e "process.exit(JSON.parse(require(\"fs\").readFileSync(process.argv[1])).ok ? 1 : 0)" "$HOME/.pi/agent/vibes-update.json"'
rm -f "$scratch/startup-fails" "$scratch/calls"
run
check "failed hotfix: retried and installed" '[ "$(calls)" = "packages rolling-packages settings pi startup " ] && [ "$(applied)" = hotfix-20260103-000000 ]'

# A failed rolling refresh is retried on the next actual hotfix run.
rm -f "$scratch/calls"
(cd "$scratch/work" && hotfix hotfix-20260104-000000 "Rolling refresh")
touch "$scratch/rolling-fails"
run
check "failed rolling refresh: not recorded" '[ "$(applied)" = hotfix-20260103-000000 ]'
check "failed rolling refresh: status reports failure" 'node -e "const s=require(process.argv[1]);process.exit(s.ok || !s.steps.some(x=>x.name===\"rolling-packages\" && !x.ok) ? 1 : 0)" "$HOME/.pi/agent/vibes-update.json"'
rm -f "$scratch/rolling-fails" "$scratch/calls"
run
check "failed rolling refresh: retried" '[ "$(calls)" = "packages rolling-packages settings pi startup " ] && [ "$(applied)" = hotfix-20260104-000000 ]'

# The hourly job: written and loaded once, left alone while unchanged.
job() {
	(
		source scripts/vibes
		LAUNCH_AGENTS=$scratch/agents LOG_FILE=$scratch/log
		launchctl() { echo "$1" >>"$scratch/launchctl"; [ "$1" != print ] || [ -e "$scratch/loaded" ]; }
		install_hotfix_job
	)
}
job
check "job installed and loaded" '[ "$(tr "\n" " " <"$scratch/launchctl")" = "bootout bootstrap " ]'
check "job plist is valid and runs hotfix-check hourly" 'plutil -lint "$scratch/agents/ai.vibes.pi-hotfix.plist" >/dev/null && [ "$(plutil -extract StartInterval raw "$scratch/agents/ai.vibes.pi-hotfix.plist")" = 3600 ] && [ "$(plutil -extract ProgramArguments.1 raw "$scratch/agents/ai.vibes.pi-hotfix.plist")" = hotfix-check ]'
rm -f "$scratch/launchctl" && touch "$scratch/loaded"
job
check "unchanged loaded job left alone" '[ "$(tr "\n" " " <"$scratch/launchctl")" = "print " ]'

[ $failures -eq 0 ] && echo ok || exit 1
