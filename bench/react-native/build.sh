#!/bin/sh
# Builds bench/react-native/build/fixture.apk by scaffolding a React Native app around App.tsx.
set -eu
cd "$(dirname "$0")"
RN=${RN_VERSION:-0.79.2}
CLI=${RN_CLI_VERSION:-18.0.0}
if [ "$(cat build/app/.rn-version 2>/dev/null)" != "$RN" ]; then
  rm -rf build/app
  npx --yes "@react-native-community/cli@$CLI" init AdriveFixture --version "$RN" \
    --package-name dev.adrive.fixture.rn --directory build/app --skip-git-init --install-pods false
  echo "$RN" > build/app/.rn-version
fi
cp App.tsx build/app/App.tsx
(cd build/app/android && ./gradlew -q assembleRelease -PreactNativeArchitectures="${RN_ARCHS:-x86_64,arm64-v8a}")
cp build/app/android/app/build/outputs/apk/release/app-release.apk build/fixture.apk
echo "Built build/fixture.apk with React Native $RN"
