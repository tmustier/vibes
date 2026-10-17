#!/bin/bash
# When a repository can't fast-forward, `vibes update` saves the local work to a backup ref, moves
# the checkout to upstream and puts back the uncommitted changes git can merge, staged as they were.
# Whatever the checkout can't keep goes to a Pi agent (faked here), which opens a PR or drops it.
set -u
cd "$(dirname "$0")/.."
source scripts/vibes
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GH_REPLY=$scratch/gh.reply GH_OPEN=$scratch/gh.open
NOTES_FILE=$scratch/notes
laptop=$scratch/repo/laptop
failures=0

# A laptop clone whose notes.txt upstream has since changed. Built once at $scratch/repo, where each
# case gets a fresh copy, so the absolute paths git recorded still hold.
mkdir -p "$scratch/repo" && cd "$scratch/repo" || exit 1
git init -q --bare -b main upstream.git
git clone -q upstream.git laptop 2>/dev/null
(cd laptop && git remote set-url origin https://github.com/test/commercial.git && git config url."$scratch/repo/upstream.git".insteadOf https://github.com/test/commercial.git)
(cd laptop && printf 'a\nb\nc\n' >notes.txt && echo x >other.txt && git add . && git commit -qm one && git push -q origin HEAD:main && git fetch -q && git branch -q -u origin/main) 2>/dev/null
git clone -q upstream.git other
(cd other && printf 'a\nb\nUPSTREAM\n' >notes.txt && git commit -qam upstream && git push -q)
cd "$scratch" && mv repo fixture || exit 1
# The fixture plus the given local state.
setup() {
	rm -rf "$scratch/repo" && cp -Rp "$scratch/fixture" "$scratch/repo" && cd "$scratch/repo/laptop" || exit 1
	eval "$1" && cd "$scratch/repo" || exit 1
}
# Runs update_repo with this resolver as the agent and checks the outcome.
expect() {
	local want=$1 got
	current=$2
	mkdir -p "$scratch/bin"
	printf '#!/bin/bash\ntouch %q; pwd >%q; git branch --show-current >%q; echo "$VIBES_PR_BRANCH" >%q\n%s\n' "$scratch/pi.ran" "$scratch/pi.pwd" "$scratch/pi.branch" "$scratch/pi.want" "$3" >"$scratch/bin/pi"
	printf '#!/bin/bash\n[ "$2" = list ] && { cat "$GH_OPEN" 2>/dev/null; exit 0; }\necho "$(pwd -P) $*" >%q\ncat "$GH_REPLY" 2>/dev/null\n' "$scratch/gh.args" >"$scratch/bin/gh"
	chmod +x "$scratch/bin/pi" "$scratch/bin/gh"
	rm -f "$scratch/pi.ran" "$GH_REPLY" "$GH_OPEN"
	rm -f "$NOTES_FILE"
	if PATH="$scratch/bin:$PATH" update_repo "$laptop" >"$scratch/out" 2>&1; then got=success; else got=failure; fi
	[ "$got" = "$want" ] || fail "$got, expected $want"
}
fail() {
	echo "FAIL: $current: $1"
	sed 's/^/    /' "$scratch/out"
	failures=$((failures + 1))
}
# A condition, run in the laptop checkout.
check() { (cd "$laptop" && eval "$2") || fail "$1"; }
ran='[ -e "$scratch/pi.ran" ]'
at_upstream='[ "$(git rev-parse HEAD)" = "$(git rev-parse @{u})" ]'
nothing_pending='[ -z "$(git for-each-ref refs/vibes/backup-\*)" ]'
pending='[ -n "$(git for-each-ref refs/vibes/backup-\*)" ]'
resolved() { git for-each-ref --format='%(refname)' refs/vibes/resolved/; }
upstream_notes='[ "$(cat notes.txt)" = "$(printf "a\nb\nUPSTREAM")" ]'
clean='[ -z "$(git status --porcelain)" ]'

# The fake gh answers for PR 7 of the checkout's repository.
pr_agent='printf "%s\t%s\t%s\t%s\t%s\t%s\n" "${STATE:-OPEN}" "${BASE:-main}" "${BRANCH:-$VIBES_PR_BRANCH}" "${CROSS:-false}" "$(git rev-parse HEAD)" https://github.com/test/commercial/pull/7 >"$GH_REPLY"
printf "{\"action\": \"pr\", \"url\": \"%s\", \"summary\": \"Kept the edit.\"}" "${URL:-https://github.com/test/commercial/pull/7}" >"$VIBES_DECISION_FILE"'
drop_agent='echo "{\"action\": \"drop\", \"summary\": \"A scratch edit.\"}" >"$VIBES_DECISION_FILE"'
dirty_first_line='printf "LOCAL\nb\nc\n" >notes.txt'
conflicting='printf "a\nb\nLOCAL\n" >notes.txt'
local_commit='printf "LOCAL\nb\nc\n" >notes.txt && git commit -qam "local commit"'

# Uncommitted changes git can merge stay in the checkout, and no agent runs.
setup "$dirty_first_line"
expect success "mergeable edit" "$drop_agent"
check "edit merged, unstaged" '[ "$(cat notes.txt)" = "$(printf "LOCAL\nb\nUPSTREAM")" ] && git diff --cached --quiet'
check "up to date, no agent" "$at_upstream && ! $ran && $nothing_pending"
check "backup kept as resolved" '[ -n "$(git for-each-ref refs/vibes/resolved/)" ]'
setup 'echo local >other.txt && echo mine >new.txt'
expect success "fast-forward with local changes" 'exit 1'
check "changes kept, no backup" '[ "$(cat other.txt)" = local ] && [ "$(cat new.txt)" = mine ] && [ -z "$(git for-each-ref refs/vibes/)" ]'
setup 'printf "LOCAL\nb\nc\n" >notes.txt && git add notes.txt'
expect success "staged edit" 'exit 1'
check "staged edit stays staged" 'git diff --quiet && [ "$(git show :notes.txt)" = "$(printf "LOCAL\nb\nUPSTREAM")" ]'
setup 'printf "STAGED\nb\nc\n" >notes.txt && git add notes.txt && printf "a\nb\nc\n" >notes.txt'
expect success "staged change the working tree undid" 'exit 1'
check "index and working tree each merged" '[ "$(git show :notes.txt)" = "$(printf "STAGED\nb\nUPSTREAM")" ] && '"$upstream_notes"
setup 'printf "b\nc\n" >notes.txt'
expect success "mergeable deletion" 'exit 1'
check "line deleted" '[ "$(cat notes.txt)" = "$(printf "b\nUPSTREAM")" ]'
setup "$dirty_first_line"' && chmod +x other.txt && ln -s $'"'"'target\n'"'"' link'
expect success "mode and symlink" 'exit 1'
check "executable bit and symlink target kept" '[ -x other.txt ] && perl -e "exit(readlink(shift) ne qq(target\n))" link'
setup "$dirty_first_line"' && git update-index --add --cacheinfo "160000,$(git rev-parse HEAD),sub"'
expect success "staged submodule pointer" 'exit 1'
check "submodule pointer stays staged" '[ "$(git ls-files -s sub | cut -c1-6)" = 160000 ]'
setup 'git mv notes.txt renamed.txt'
expect success "staged rename" 'exit 1'
check "rename merged and staged" '[ "$(git show :renamed.txt)" = "$(printf "a\nb\nUPSTREAM")" ] && ! git ls-files --error-unmatch notes.txt 2>/dev/null && git diff --quiet'
setup "$dirty_first_line"' && echo "*.tmp" >.git/info/exclude && echo STAGED >s.tmp && git add -f s.tmp && echo EDITED >s.tmp'
expect success "force-added ignored file" 'exit 1'
check "staged and edited versions kept" '[ "$(git show :s.tmp)" = STAGED ] && [ "$(cat s.tmp)" = EDITED ]'

# A conflicting edit: the checkout takes upstream's version and the agent opens a PR from a separate worktree.
setup "$conflicting"
expect success "conflict, PR" "$pr_agent"
check "checkout at upstream" "$at_upstream && $upstream_notes && $clean"
check "agent ran in a separate worktree, on its branch" "$ran"' && [ "$(cat "$scratch/pi.pwd")" != "$(pwd -P)" ] && [ -z "$(git worktree list | sed 1d)" ] && [ "$(cat "$scratch/pi.branch")" = "$(cat "$scratch/pi.want")" ]'
check "branch removed once resolved" '[ -z "$(git branch --list "vibes/*")" ]'
check "PR looked up by number in the upstream remote's repository" '[ "$(cut -d" " -f2- "$scratch/gh.args")" = "pr view 7 -R https://github.com/test/commercial.git --json state,baseRefName,headRefName,isCrossRepository,headRefOid,url --jq [.state, .baseRefName, .headRefName, .isCrossRepository, .headRefOid, .url] | @tsv" ]'
check "resolved, PR noted" "$nothing_pending"' && grep -q "https://github.com/test/commercial/pull/7" "$NOTES_FILE"'
check "backup has the edit and names the path" '[ "$(git show $(resolved):notes.txt | tail -1)" = LOCAL ] && git show -s $(resolved) | grep -q "^ *notes.txt"'
setup "$conflicting"
expect success "conflict, dropped" "$drop_agent"
check "drop noted, backup kept" "$nothing_pending"' && grep -q "dropped local work.*A scratch edit\..*refs/vibes/resolved/backup-" "$NOTES_FILE"'

# A staged version that conflicts while the working tree's merges: the working tree keeps its edit,
# the index takes upstream's version, and the staged version goes to the agent.
setup 'printf "a\nb\nSTAGED\n" >notes.txt && git add notes.txt && printf "LOCAL\nb\nc\n" >notes.txt'
expect success "conflicting staged version" "$drop_agent"
check "working tree merged, index upstream" '[ "$(cat notes.txt)" = "$(printf "LOCAL\nb\nUPSTREAM")" ] && [ "$(git show :notes.txt)" = "$(git show @{u}:notes.txt)" ] && '"$ran"
check "staged version saved" '[ "$(git show $(resolved)^2:notes.txt | tail -1)" = STAGED ]'

# A conflict in a file whose name has a newline doesn't cost the checkout a mergeable edit elsewhere.
newline_name=$'cfg\nfile'
setup 'git pull -q --ff-only && echo base >"$newline_name" && git add -- "$newline_name" && git commit -qm cfg && git push -q && (cd "$scratch/repo/other" && git pull -q && echo theirs >"$newline_name" && printf "a\nb\nUPSTREAM2\n" >notes.txt && git commit -qam cfg2 && git push -q) && echo mine >"$newline_name" && printf "LOCAL\nb\nUPSTREAM\n" >notes.txt'
expect success "conflict in a file named with a newline" "$drop_agent"
check "other edit merged, conflicting file upstream's" '[ "$(cat notes.txt)" = "$(printf "LOCAL\nb\nUPSTREAM2")" ] && [ "$(cat "$newline_name")" = theirs ]'

# An unstaged rename of a file upstream deleted: upstream wins, and the renamed file goes with the backup.
setup 'mv notes.txt moved.txt && echo local >other.txt'
(cd "$scratch/repo/other" && git rm -q notes.txt && echo theirs >other.txt && git commit -qam "delete notes" && git push -q)
expect success "rename of a file upstream deleted" "$drop_agent"
check "neither file left, rename saved" '[ ! -e notes.txt ] && [ ! -e moved.txt ] && '"$clean"' && git show $(resolved):moved.txt >/dev/null'

# Local commits leave the branch for the agent; mergeable uncommitted changes stay.
setup "$local_commit"' && echo local >other.txt'
expect success "local commit" "$pr_agent"
check "branch at upstream, other.txt kept" "$at_upstream && $upstream_notes"' && [ "$(cat other.txt)" = local ] && '"$ran"
check "backup lists the commit" 'git show -s $(resolved) | grep -q "local commit" && [ "$(git show $(resolved)^1:notes.txt | head -1)" = LOCAL ]'

# Untracked and ignored files at paths upstream now uses: upstream's version, the local one saved.
setup 'echo mine >added.txt'
(cd "$scratch/repo/other" && echo theirs >added.txt && git add added.txt && git commit -qm add && git push -q)
expect success "untracked file upstream adds" "$drop_agent"
check "upstream's file, local one saved" '[ "$(cat added.txt)" = theirs ] && [ "$(git show $(resolved):added.txt)" = mine ]'
ignored_upstream() {
	echo "config.tmp" >.git/info/exclude && echo PERSONAL >config.tmp
	(cd "$scratch/repo/other" && echo UPSTREAM >config.tmp && git add config.tmp && git commit -qm config && git push -q)
}
setup ignored_upstream
expect success "ignored file upstream starts tracking" "$drop_agent"
check "upstream's file, local one saved" '[ "$(cat config.tmp)" = UPSTREAM ] && [ "$(git show $(resolved):config.tmp)" = PERSONAL ]'
for name in "$(printf 'config\t.tmp')" "café.tmp"; do
	setup "printf '%s\n' '$name' >.git/info/exclude && echo PERSONAL >'$name'"
	(cd "$scratch/repo/other" && echo UPSTREAM >"$name" && git add -- "$name" && git commit -qm quoted && git push -q)
	expect success "ignored file named $name" "$drop_agent"
	check "saved" '[ "$(git cat-file blob "$(git ls-tree -z $(resolved) -- "'"$name"'" | cut -d" " -f3 | cut -f1)")" = PERSONAL ]'
done
setup 'echo "*.secret" >.git/info/exclude && mkdir cache && echo PERSONAL >cache/private.secret'
(cd "$scratch/repo/other" && ln -s notes.txt cache && git add cache && git commit -qm cache && git push -q)
expect success "ignored file in a folder upstream replaces" "$drop_agent"
check "symlink in place, file saved" '[ -L cache ] && [ "$(git show $(resolved):cache/private.secret)" = PERSONAL ]'
setup 'echo conf >.git/info/exclude && echo PERSONAL >conf'
(cd "$scratch/repo/other" && mkdir conf && echo x >conf/x && git add conf && git commit -qm conf && git push -q)
expect success "ignored file where upstream needs a folder" "$drop_agent"
check "folder in place, file saved" '[ "$(cat conf/x)" = x ] && [ "$(git show $(resolved):conf)" = PERSONAL ]'
setup '(cd "$scratch/repo/other" && git pull -q && mkdir -p conf && echo x >conf/x && git add conf && git commit -qm conf && git push -q) && git pull -q --ff-only && echo conf >.git/info/exclude && rm -r conf && echo PERSONAL >conf'
(cd "$scratch/repo/other" && echo y >conf/x && git commit -qam "edit conf/x" && git push -q)
expect success "ignored file over a folder upstream edits in" "$drop_agent"
check "upstream's folder, file saved" '[ "$(cat conf/x)" = y ] && [ "$(git show $(resolved):conf)" = PERSONAL ]'

# When the agent doesn't finish, the work stays pending and the next update tries again.
setup "$conflicting"
expect failure "agent fails" 'exit 1'
check "checkout updated, backup pending" "$at_upstream && $upstream_notes && $pending"
expect success "next night, retried" "$pr_agent"
check "resolved" "$ran && $nothing_pending"
setup "$conflicting"
expect failure "agent writes no decision" 'true'
check "pending" "$pending"
# A retry continues on the branch an earlier attempt started.
setup "$conflicting"
expect failure "attempt commits, then fails" 'echo attempt >attempt.txt && git add attempt.txt && git commit -qm "first attempt" && exit 1'
expect success "retry" '[ "$(git log -1 --format=%s)" = "first attempt" ] || exit 1
'"$pr_agent"
check "resolved" "$nothing_pending"
setup "$conflicting"
AGENT_TIMEOUT_SECONDS=1 expect failure "agent times out" 'sleep 5'
check "pending" "$pending"
setup "$conflicting"
expect failure "agent edits the checkout" "echo edited >>'$laptop/other.txt'; $drop_agent"
check "pending" "$pending"

# The PR must be open, from the branch Vibes named, into the upstream branch of this repository.
for bad in STATE=CLOSED BASE=release BRANCH=vibes/someone-else CROSS=true URL=https://github.com/elsewhere/commercial/pull/7; do
	setup "$conflicting"
	export "${bad?}"
	expect failure "PR with $bad" "$pr_agent"
	unset "${bad%%=*}"
	check "pending" "$pending"
done

# A PR whose head isn't the agent's last commit (committed, not pushed) is not accepted.
setup "$conflicting"
expect failure "PR behind the agent's branch" "$pr_agent"'
echo more >more.txt && git add more.txt && git commit -qm "not pushed"'
check "pending" "$pending"

# If updating the checkout fails, the backup stays for the agent and says the checkout may lack any of
# it, even when the checkout was going to keep all of it.
setup "$dirty_first_line"
git() { if [[ "$*" == "-C $laptop read-tree --reset -u "* ]]; then return 1; fi; command git "$@"; }
expect failure "checkout update fails" 'exit 1'
unset -f git
check "pending, and says so" "$pending"' && git show -s $(git for-each-ref --format="%(refname)" "refs/vibes/backup-*") | grep -q "Updating the checkout failed"'
expect success "next night" "$pr_agent"
check "resolved" "$nothing_pending"

# ...also when checking the result fails.
setup "$dirty_first_line"
snapshot_real=$(declare -f snapshot_local_work)
snapshot_local_work() { [ "$(command git -C "$1" rev-parse HEAD)" = "$(command git -C "$1" rev-parse @{u})" ] && return 1; eval "${snapshot_real/snapshot_local_work/snapshot_inner}"; snapshot_inner "$@"; }
expect failure "checking the checkout fails" 'exit 1'
eval "$snapshot_real"
check "pending, and says so" "$pending"' && git show -s $(git for-each-ref --format="%(refname)" "refs/vibes/backup-*") | grep -q "Updating the checkout failed"'

# A resolved backup is never overwritten.
setup "$conflicting"
git() { if [ "${1:-} ${2:-} ${3:-} ${4:-}" = "-C $laptop update-ref --stdin" ]; then local input; input=$(cat); case $input in *refs/vibes/resolved/*) command git -C "$laptop" update-ref "$(sed -n 's/^create \([^ ]*\) .*/\1/p' <<<"$input")" "$(command git -C "$laptop" rev-parse HEAD)" ;; esac; command git -C "$laptop" update-ref --stdin <<<"$input"; return; fi; command git "$@"; }
expect failure "resolved ref already exists" "$drop_agent"
unset -f git
check "pending, the existing ref untouched, no note" "$pending"' && [ "$(git rev-parse $(resolved))" = "$(git rev-parse HEAD)" ] && [ ! -e "$NOTES_FILE" ]'

# A drop while an earlier attempt's PR is still open is not accepted.
setup "$conflicting"
expect failure "drop with an open PR" "echo https://github.com/test/commercial/pull/7 >\"\$GH_OPEN\"; $drop_agent"
check "pending" "$pending"

# A file upstream stops ignoring stays, and isn't mistaken for local work.
setup 'git pull -q --ff-only && echo "*.private" >.gitignore && git add .gitignore && git commit -qm ignore && git push -q && echo SECRET >secret.private && '"$conflicting"
(cd "$scratch/repo/other" && git pull -q && echo "# nothing ignored" >.gitignore && printf "a\nb\nUPSTREAM2\n" >notes.txt && git commit -qam "stop ignoring" && git push -q)
expect success "file upstream stops ignoring" "$drop_agent"
check "file kept" '[ "$(cat secret.private)" = SECRET ] && '"$at_upstream"

# The PR is looked up in the repository of the remote the branch tracks, not another remote.
setup "$conflicting"' && git remote rename origin team && git remote add origin https://github.com/someone/unrelated.git'
expect success "branch tracking a remote other than origin" "$pr_agent"
check "PR looked up in the tracked remote's repository" 'grep -q " -R https://github.com/test/commercial.git " "$scratch/gh.args"'

# No upstream: nothing changes.
setup "$dirty_first_line"' && git branch -q --unset-upstream'
expect failure "no upstream" 'exit 1'
check "untouched" '[ "$(head -1 notes.txt)" = LOCAL ] && [ -z "$(git for-each-ref refs/vibes/)" ]'

[ $failures -eq 0 ] && echo ok || exit 1
