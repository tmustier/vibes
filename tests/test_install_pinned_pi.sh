#!/bin/bash
# Exercise the real installer without touching any user/global install.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
node_dir=$(dirname "$(command -v node)")
export HOME=$scratch/home
export PI_CODING_AGENT_DIR=$HOME/.pi/agent
mkdir -p "$HOME/.pi/agent"
source scripts/vibes
VIBES=$scratch/vibes
mkdir -p "$VIBES" "$scratch/prefix/bin"
cutoff=2026-10-13T17:28:06Z
printf '{"devDependencies":{"@earendil-works/pi-coding-agent":"1.2.0"},"piDependencyCutoff":"%s"}\n' "$cutoff" >"$VIBES/package.json"
fake_bin=$scratch/prefix/bin/pi
printf '#!/bin/bash\necho 1.1.0\n' >"$fake_bin"
chmod +x "$fake_bin"
pi_bin() { [ -e "$fake_bin" ] && echo "$fake_bin"; }
npm() {
	printf '%s\n' "$@" >"$scratch/npm-args"
	printf '#!/bin/bash\necho 1.2.0\n' >"$fake_bin"
	chmod +x "$fake_bin"
}
expect() {
	printf '%s\n' "$@" >"$scratch/expected"
	cmp "$scratch/expected" "$scratch/npm-args"
}
install_pinned_pi
expect install -g --prefix "$scratch/prefix" --before "$cutoff" @earendil-works/pi-coding-agent@1.2.0
rm "$scratch/npm-args"
install_pinned_pi
[ ! -e "$scratch/npm-args" ] # Already-installed Pi is left alone.
rm "$fake_bin"
install_pinned_pi
expect install -g --before "$cutoff" @earendil-works/pi-coding-agent@1.2.0

# A previous night's script hands over to cmd_update with these exact variables.
# Keep its real Pi installation, stubbing only unrelated machine-wide operations.
printf '#!/bin/bash\necho 1.1.0\n' >"$fake_bin"
mkdir -p "$VIBES/scripts" "$scratch/previous"
printf 'test guidance\n' >"$VIBES/AGENTS.template.md"
for file in settings subagent-config web-search; do echo '{}' >"$VIBES/$file.template.json"; done
printf '#!/bin/bash\nexit 0\n' >"$VIBES/scripts/inventory"
chmod +x "$VIBES/scripts/inventory"
cp "$VIBES/scripts/inventory" "$VIBES/scripts/usage-telemetry"
cp scripts/refresh "$VIBES/scripts/refresh"
STATUS_FILE=$scratch/status NOTES_FILE=$scratch/notes LOG_FILE=$scratch/log
VIBES_UPDATE_LOCKED=1 VIBES_UPDATE_CONTINUED=1 VIBES_UPDATE_PREVIOUS=$scratch/previous VIBES_UPDATE_RESULTS=$'packages\tok\t'
for f in load_nvm refresh_rolling_packages sync_settings install_hotfix_job install_refresh_job update_repo cmd_check osascript; do eval "$f() { :; }"; done
cmd_update >/dev/null
expect install -g --prefix "$scratch/prefix" --before "$cutoff" @earendil-works/pi-coding-agent@1.2.0

# The hotfix path also reaches the same real installer with the cutoff in the downloaded package.
printf '#!/bin/bash\necho 1.1.0\n' >"$fake_bin"
HOTFIX_FILE=$scratch/hotfix
latest_hotfix() { echo hotfix-test; }
pi_running() { return 1; }
update_vibes_packages() { :; }
git() {
	case "$*" in
		*' show '*) cat "$VIBES/package.json" ;;
		*' tag '*) echo 'Test cutoff' ;;
	esac
}
load_nvm() { export PATH="$node_dir:$PATH"; }
log_output() { :; }
cmd_hotfix_check >/dev/null
expect install -g --prefix "$scratch/prefix" --before "$cutoff" @earendil-works/pi-coding-agent@1.2.0
[ "$(cat "$HOTFIX_FILE")" = hotfix-test ]

echo 'ok: cutoff, existing prefix, no Pi wrapper, already-installed Pi, fresh install, nightly handover and hotfix'
