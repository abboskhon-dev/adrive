#!/bin/sh
# Builds bench/flutter/build/fixture.apk by scaffolding a Flutter app around lib/main.dart.
set -eu
cd "$(dirname "$0")"
mkdir -p build/app/lib
cp pubspec.yaml build/app/ && cp lib/main.dart build/app/lib/
(cd build/app && flutter create -t app --platforms android --org dev.adrive.fixture --project-name adrive_fixture . >/dev/null \
  && sed -i.bak 's/applicationId = ".*"/applicationId = "dev.adrive.fixture.flutter"/' android/app/build.gradle* \
  && grep -q '"dev.adrive.fixture.flutter"' android/app/build.gradle* \
  && flutter build apk --release)
cp build/app/build/app/outputs/flutter-apk/app-release.apk build/fixture.apk
echo "Built build/fixture.apk"
