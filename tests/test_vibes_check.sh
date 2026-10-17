#!/bin/bash
# vibes check must report what Pi shows at startup: a skill conflict (Pi starts), a tool
# conflict (Pi exits), and failures that arrive after a quiet screen. Needs tmux and `npm install --omit=dev`.
set -u
cd "$(dirname "$0")/.."
export PI_CODING_AGENT_DIR=$(mktemp -d)
trap 'rm -rf "$PI_CODING_AGENT_DIR"' EXIT
printf '{"packages":["%s"]}\n' "$PWD" >"$PI_CODING_AGENT_DIR/settings.json"

# The gog warning reads configuration only and never changes credentials or fails the check.
source scripts/vibes
(
	uname() { echo Darwin; }
	gog() {
		[ "$*" = 'auth keyring --plain --no-input' ] || { echo 'unexpected gog command' >&2; exit 1; }
		printf 'keyring_backend\t%s\n' "$gog_backend"
	}
	for gog_backend in auto keychain; do
		output=$(check_gog_keyring) || exit 1
		grep -q 'WARNING: gog uses macOS Keychain' <<<"$output" &&
			grep -q 'docs/gog-credentials.md' <<<"$output" || { echo "FAIL gog $gog_backend warning"; exit 1; }
	done
	gog_backend=file
	[ -z "$(check_gog_keyring)" ] || { echo 'FAIL gog file backend warning'; exit 1; }
	uname() { echo Linux; }
	gog_backend=auto
	[ -z "$(check_gog_keyring)" ] || { echo 'FAIL gog warning outside macOS'; exit 1; }
) || exit 1

# expect_problem <name> <pattern>...
expect_problem() {
	local name=$1 pattern output
	shift
	if output=$(scripts/vibes check); then echo "FAIL $name: reported a clean start"; exit 1; fi
	for pattern in "$@"; do
		grep -q "$pattern" <<<"$output" || { echo "FAIL $name: missing $pattern in:"; echo "$output"; exit 1; }
	done
}

mkdir -p "$PI_CODING_AGENT_DIR/skills" && cp -R skills/visual-verify "$PI_CODING_AGENT_DIR/skills/"
expect_problem "skill conflict" '"visual-verify" collision'
rm -rf "$PI_CODING_AGENT_DIR/skills"

mkdir -p "$PI_CODING_AGENT_DIR/extensions" "$PI_CODING_AGENT_DIR/lib"
cp extensions/papercut.ts "$PI_CODING_AGENT_DIR/extensions/"
cp lib/feature.ts lib/features.ts "$PI_CODING_AGENT_DIR/lib/"
expect_problem "tool conflict" 'Pi exited while starting' 'Tool "papercut" conflicts'
rm -rf "$PI_CODING_AGENT_DIR/extensions" "$PI_CODING_AGENT_DIR/lib"

# A named opt-out of the internal readiness wrapper must not hang the check.
printf '{"features":{"vibes-check":false}}\n' >"$PI_CODING_AGENT_DIR/vibes.json"
scripts/vibes check || { echo 'FAIL readiness feature opt-out'; exit 1; }
rm "$PI_CODING_AGENT_DIR/vibes.json"

# Failures that arrive late must not be missed: a slow extension, then a slow session_start handler.
# Each delay keeps the screen quiet for longer than a check that stops at a quiet screen would wait.
mkdir -p "$PI_CODING_AGENT_DIR/extensions"
cat >"$PI_CODING_AGENT_DIR/extensions/late.ts" <<'TS'
export default async function () {
	await new Promise((resolve) => setTimeout(resolve, 10000));
	throw new Error("late extension failure");
}
TS
expect_problem "slow extension" 'late extension failure'
cat >"$PI_CODING_AGENT_DIR/extensions/late.ts" <<'TS'
export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		await new Promise((resolve) => setTimeout(resolve, 10000));
		ctx.ui.notify("late session_start failure", "error");
	});
}
TS
expect_problem "slow session_start" 'late session_start failure'

# In a checkout of a package the user also installs (~/projects/commercial), Pi uses the checkout's
# copy of each skill: not a problem. The same skill at another path in the package still is, and so
# is the same path in another package. The screens are as Pi prints them: the kept path resolved,
# the skipped ones as configured.
source scripts/vibes
work=$PI_CODING_AGENT_DIR/work
mkdir -p "$work/checkout" "$work/package" "$work/other"
echo '{"name":"probe-package"}' | tee "$work/checkout/package.json" >"$work/package/package.json"
echo '{"name":"other-package"}' >"$work/other/package.json"
checkout=$(cd "$work/checkout" && pwd -P)
skill=.agents/skills/probe-skill/SKILL.md
# expect_collision <name> <reported: yes or no> <skipped path>...
expect_collision() {
	local name=$1 want=$2 output
	shift 2
	output=$({
		printf '[Skill conflicts]\n  "probe-skill" collision:\n    ✓ auto (project) %s\n' "$checkout/$skill"
		printf '    ✗ %s (skipped)\n' "$@"
		echo
	} | startup_problems "$checkout")
	[ "$([ -n "$output" ] && echo yes || echo no)" = "$want" ] || { echo "FAIL $name: expected reported=$want, got:"; echo "$output"; exit 1; }
}
expect_collision "checkout of an installed package" no "$work/package/$skill"
expect_collision "same skill at another path" yes "$work/package/.claude/skills/probe-skill/SKILL.md"
expect_collision "same path in another package" yes "$work/other/$skill"
expect_collision "two skipped copies, one foreign" yes "$work/package/$skill" "$work/other/$skill"
echo ok
