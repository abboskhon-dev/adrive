#!/bin/sh
# Real-device check: needs one booted device or emulator. Writes "check<TAB>pass|fail|skip" lines to $1 if given.
# ADRIVE_REQUIRE_FIXTURES=1 fails, instead of skipping, a fixture that is not built.
set -ux
out=${1:-/dev/null}
case $out in /*) ;; *) out="$PWD/$out" ;; esac
: > "$out" || exit 1
cd "$(dirname "$0")/.."
A="node adrive.mjs"
has_windows='const j=JSON.parse(require("fs").readFileSync(0));if(!j.windows?.length)process.exit(1)'
failed=0
record() { printf '%s\t%s\n' "$1" "$2" >> "$out"; [ "$2" != fail ] || failed=1; }
check() { name=$1; shift; if "$@"; then record "$name" pass; else record "$name" fail; fi; }

settings() {
  $A launch com.android.settings || return 1
  for i in $(seq 20); do $A current | grep -q com.android.settings && return; sleep 1; done
  return 1
}
check launch settings
check 'ui one-shot' sh -c "ADRIVE_NO_DAEMON=1 $A ui | grep -q ."
check 'ui daemon' sh -c "$A ui --json | node -e '$has_windows' && $A daemon status | grep -q '^running'"
check 'ui --windows' sh -c "$A ui --windows --json | node -e '$has_windows'"
check look sh -c "$A look | grep -q '^\[1\] '"
check key $A key home
$A daemon stop

for f in fixture compose flutter react-native; do
  if [ -f "bench/$f/build/fixture.apk" ]; then check "$f" ./test/fixtures.sh "$f"
  elif [ "${ADRIVE_REQUIRE_FIXTURES:-}" = 1 ]; then echo "$f: no bench/$f/build/fixture.apk"; record "$f" fail
  else record "$f" skip; fi
done
exit $failed
