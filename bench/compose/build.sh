#!/bin/sh
# Builds bench/compose/build/fixture.apk.
set -eu
cd "$(dirname "$0")"
./gradlew -q assembleRelease
mkdir -p build && cp app/build/outputs/apk/release/app-release.apk build/fixture.apk
echo "Built build/fixture.apk"
