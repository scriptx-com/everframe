<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter Android dry run

This unreleased sample checks the Android method-channel bridge, captures masked Flutter renderer frames, and passes them to the native reporter. A local dry run submitted a report with a masked screenshot and replay to a loopback fake ingest. See `docs/dry-runs/flutter-android-native-bridge.md` for the evidence and limits.

The sample requires disposable `0.9.0-DEV` Android SDK artifacts. For emulator builds, use a local ingest address:

```sh
cd packages/sdk-android/android
EVERFRAME_DEV_INGEST_URL=http://10.0.2.2:8937 ./gradlew -Dmaven.repo.local=/tmp/everframe-flutter-android-m2 -PeverframeDevLocal=true :everframe-protocol:publishToMavenLocal :everframe-core:publishToMavenLocal :everframe-reporter-ui:publishToMavenLocal

cd ../../../examples/flutter-android-probe
flutter pub get
flutter test
flutter analyze
MAVEN_LOCAL_REPOSITORY=/tmp/everframe-flutter-android-m2 flutter build apk --debug
MAVEN_LOCAL_REPOSITORY=/tmp/everframe-flutter-android-m2 flutter test integration_test/android_probe_test.dart -d emulator-5554
```

The app uses a throwaway key unless `EVERFRAME_APP_ID` and `EVERFRAME_SDK_KEY` are supplied as Dart defines. The bridge accepts only the development environment and starts the native SDK with additional screenshots and automatic crash capture disabled. `Start dry run` invokes the native SDK; `Open reporter` captures a masked Flutter screenshot and opens the native UI. `Record Dart context` explicitly stores a handled Dart error and adds an origin-only network breadcrumb. The integration test checks method-channel routing, handled-error storage acknowledgement, and masked Flutter A/B frames. Local manual submissions exercised the reporter and Flutter SDK identity; one later manual report omitted replay, which remains under investigation. Embedded platform views, automatic Dart error and network hooks, offline retry, real devices, and dashboard delivery remain unverified.
