#!/bin/sh
set -eu
cd "$(dirname "$0")/helper"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [ -z "$SDK" ] || [ ! -d "$SDK" ]; then
  echo "Set ANDROID_HOME (or ANDROID_SDK_ROOT) to an installed Android SDK." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required." >&2; exit 1; }
command -v javac >/dev/null 2>&1 || { echo "JDK 17+ is required (javac not found)." >&2; exit 1; }
# Select numeric stable versions, not lexicographic order or preview packages.
latest() {
  node --input-type=module - "$1" "$2" <<'NODE'
import { readdirSync } from 'node:fs'
const [dir, prefix] = process.argv.slice(2)
let versions = []
try { versions = readdirSync(dir).filter(v => v.startsWith(prefix) && /^\d+(?:\.\d+)*$/.test(v.slice(prefix.length))) } catch {}
versions.sort((a, b) => {
  const x = a.slice(prefix.length).split('.').map(Number), y = b.slice(prefix.length).split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
})
process.stdout.write(versions.at(-1) ?? '')
NODE
}
PLATFORM=${ANDROID_PLATFORM:-$(latest "$SDK/platforms" android-)}
TOOLS=${ANDROID_BUILD_TOOLS:-$(latest "$SDK/build-tools" '')}
JAR="$SDK/platforms/$PLATFORM/android.jar"
D8="$SDK/build-tools/$TOOLS/d8"
if [ ! -f "$JAR" ]; then echo "Android platform missing: $JAR; install one or set ANDROID_PLATFORM=android-36." >&2; exit 1; fi
if [ ! -x "$D8" ]; then echo "Android d8 missing: $D8; install build-tools or set ANDROID_BUILD_TOOLS." >&2; exit 1; fi
mkdir -p build
javac --release 8 -nowarn -cp "$JAR" -d build Dump.java
"$D8" --min-api 26 --lib "$JAR" --output build build/Dump.class
printf 'Built helper with %s / build-tools %s\n' "$PLATFORM" "$TOOLS"
