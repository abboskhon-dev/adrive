#!/bin/sh
# Builds bench/fixture/build/fixture.apk without Gradle.
set -eu
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[ -d "$SDK" ] || { echo "Set ANDROID_HOME to an installed Android SDK." >&2; exit 1; }
PLATFORM=${ANDROID_PLATFORM:-$(ls "$SDK/platforms" | grep -E '^android-[0-9]+$' | sort -t- -k2 -n | tail -1)}
TOOLS=${ANDROID_BUILD_TOOLS:-$(ls "$SDK/build-tools" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)}
JAR="$SDK/platforms/$PLATFORM/android.jar"
BT="$SDK/build-tools/$TOOLS"
rm -rf build && mkdir -p build/classes
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 35 --version-code 1 --version-name 1
javac --release 8 -nowarn -cp "$JAR" -d build/classes $(find src -name '*.java')
"$BT/d8" --min-api 26 --lib "$JAR" --output build $(find build/classes -name '*.class')
(cd build && cp base.apk unsigned.apk && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
"$BT/apksigner" sign --ks "${KEYSTORE:-$HOME/.android/debug.keystore}" --ks-pass pass:android \
  --out build/fixture.apk build/aligned.apk
echo "Built build/fixture.apk with $PLATFORM / build-tools $TOOLS"
