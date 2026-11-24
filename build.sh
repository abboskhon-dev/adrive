#!/bin/sh
set -eu
cd "$(dirname "$0")/helper"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [ -z "$SDK" ] || [ ! -d "$SDK" ]; then
  echo "Set ANDROID_HOME (or ANDROID_SDK_ROOT) to an installed Android SDK." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required." >&2; exit 1; }
command -v javac >/dev/null 2>&1 || { echo "JDK 17 is required (javac not found)." >&2; exit 1; }
case "$(javac -version 2>&1)" in "javac 17."*) ;; *) echo "warning: release dex is built with JDK 17; other versions may not match its hash." >&2 ;; esac
# Pinned so the dex rebuilds byte for byte; build-tools changes the output.
PLATFORM=${ANDROID_PLATFORM:-android-36}
TOOLS=${ANDROID_BUILD_TOOLS:-36.0.0}
JAR="$SDK/platforms/$PLATFORM/android.jar"
D8="$SDK/build-tools/$TOOLS/d8"
if [ ! -f "$JAR" ]; then echo "Android platform missing: $JAR; run sdkmanager "platforms;$PLATFORM" or set ANDROID_PLATFORM." >&2; exit 1; fi
if [ ! -x "$D8" ]; then echo "Android d8 missing: $D8; run sdkmanager "build-tools;$TOOLS" or set ANDROID_BUILD_TOOLS." >&2; exit 1; fi
mkdir -p build
javac --release 8 -nowarn -cp "$JAR" -d build Dump.java
"$D8" --min-api 26 --lib "$JAR" --output build build/Dump.class
printf 'Built helper with %s / build-tools %s, sha256 %s\n' "$PLATFORM" "$TOOLS" "$(node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync('build/classes.dex')).digest('hex'))")"
