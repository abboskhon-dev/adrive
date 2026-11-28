#!/bin/sh
# Checks ui/tap/wait/type on each built fixture in bench/, or only the named ones: needs one booted device or emulator.
set -eu
cd "$(dirname "$0")/.."
A="node adrive.mjs"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
AAPT2=$(command -v aapt2 || ls "$SDK"/build-tools/*/aapt2 2>/dev/null | tail -1)
[ -n "$AAPT2" ] || { echo "Set ANDROID_HOME to an installed Android SDK, or put aapt2 on PATH." >&2; exit 1; }
TIMER='[0-9]+:[0-9]{2}\.[0-9]{3}'
ran=0
for dir in ${*:-fixture compose flutter react-native}; do
  apk=bench/$dir/build/fixture.apk
  [ -f "$apk" ] || { echo "skip $dir: no $apk"; continue; }
  pkg=$("$AAPT2" dump packagename "$apk")
  echo "== $dir ($pkg)"
  log=$(adb install -r -g "$apk" 2>&1) || { echo "$dir: install failed"; echo "$log"; exit 1; }
  adb shell am force-stop "$pkg"
  $A launch "$pkg"
  out=$($A ui --wait 'Mute Bass') || { echo "$dir: 'Mute Bass' never appeared"; echo "$out"; exit 1; }
  for label in 'Mute Bass' 'taps 0' 'Stem 0'; do
    echo "$out" | grep -q "$label" || { echo "$dir: ui is missing '$label'"; echo "$out"; exit 1; }
  done
  t1=$(echo "$out" | grep -Eo "$TIMER" | head -1)
  [ -n "$t1" ] || { echo "$dir: ui is missing the timer"; echo "$out"; exit 1; }
  # Give a slow emulator a few seconds to draw the next frame.
  for i in 1 2 3 4 5; do t2=$($A ui | grep -Eo "$TIMER" | head -1 || true); [ -z "$t2" ] || [ "$t1" = "$t2" ] || break; sleep 1; done
  [ -n "$t2" ] || { echo "$dir: a later ui read has no timer"; exit 1; }
  [ "$t1" != "$t2" ] || { echo "$dir: the timer is stuck at $t1"; exit 1; }
  $A tap 'Mute Bass' --quiet
  $A wait 'taps 1' 5
  $A tap Note --quiet
  $A type --quiet -- 'Größe 日本 👍'
  $A ui | grep -q 'Größe 日本 👍' || { echo "$dir: type did not set the Note field"; $A ui; exit 1; }
  adb shell am force-stop "$pkg"
  ran=$((ran + 1))
done
[ "$ran" -gt 0 ] || { echo "no fixtures built"; exit 1; }
$A daemon stop
echo "ok: $ran fixtures"
