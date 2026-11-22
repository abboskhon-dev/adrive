#!/bin/sh
# Real-device check for CI: needs one booted device or emulator.
set -eux
cd "$(dirname "$0")/.."
A="node adrive.mjs"
has_windows='const j=JSON.parse(require("fs").readFileSync(0));if(!j.windows?.length)process.exit(1)'
$A launch com.android.settings
for i in $(seq 20); do $A current | grep -q com.android.settings && break; sleep 1; done
$A current | grep -q com.android.settings
ADRIVE_NO_DAEMON=1 $A ui | grep -q .
$A ui --json | node -e "$has_windows"
$A ui --windows --json | node -e "$has_windows"
$A daemon status | grep -q '^running'
$A key home
$A daemon stop
