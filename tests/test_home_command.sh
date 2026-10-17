#!/bin/bash
set -eu
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/repo/scripts" "$root/bin"
cp "$(dirname "$0")/../scripts/home-vibes" "$root/repo/scripts/home-vibes"
printf '#!/bin/bash\nprintf "home:%%s\\n" "$*"\n' >"$root/repo/scripts/vibes"
chmod +x "$root/repo/scripts/vibes"
ln -s "$root/repo/scripts/home-vibes" "$root/bin/vibes"
actual=$("$root/bin/vibes" features)
[ "$actual" = 'home:features' ] || { echo "Wrong package root: $actual"; exit 1; }
actual=$("$root/bin/vibes" report /synthetic/session.jsonl fixed)
[ "$actual" = 'home:report /synthetic/session.jsonl fixed' ] || { echo "Report did not reach the configurable destination"; exit 1; }
for command in refresh hotfix hotfix-check; do
  if "$root/bin/vibes" "$command" >"$root/result" 2>&1; then
    echo "Home command unexpectedly allowed $command"; exit 1
  else
    [ "$?" -eq 2 ] || { echo "Wrong exit status for $command"; exit 1; }
  fi
  grep -q 'This home setup does not run managed refresh or hotfix commands.' "$root/result"
  ! grep -q '^home:' "$root/result" || { echo "Forwarded $command to work updater"; exit 1; }
done
echo 'home command follows its symlink and excludes work jobs: ok'
