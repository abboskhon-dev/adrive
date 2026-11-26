#!/bin/sh
# Checks ui/tap/wait on each built fixture in bench/: needs one booted device or emulator.
set -eu
cd "$(dirname "$0")/.."
A="node adrive.mjs"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
AAPT2=$(command -v aapt2 || ls "$SDK"/build-tools/*/aapt2 | tail -1)
ran=0
for dir in fixture compose flutter react-native; do
  apk=bench/$dir/build/fixture.apk
  [ -f "$apk" ] || { echo "skip $dir: no $apk"; continue; }
  pkg=$("$AAPT2" dump packagename "$apk")
  echo "== $dir ($pkg)"
  adb install -r -g "$apk" >/dev/null 2>&1
  adb shell am force-stop "$pkg"
  $A launch "$pkg"
  out=$($A ui --wait 'Mute Bass')
  for label in 'Mute Bass' 'taps 0' 'Stem 0'; do
    echo "$out" | grep -q "$label" || { echo "$dir: ui is missing '$label'"; echo "$out"; exit 1; }
  done
  echo "$out" | grep -Eq '[0-9]+:[0-9]{2}\.[0-9]{3}' || { echo "$dir: ui is missing the timer"; echo "$out"; exit 1; }
  $A tap 'Mute Bass' --quiet
  $A wait 'taps 1' 5
  adb shell am force-stop "$pkg"
  ran=$((ran + 1))
done
[ "$ran" -gt 0 ] || { echo "no fixtures built"; exit 1; }
$A daemon stop
echo "ok: $ran fixtures"
