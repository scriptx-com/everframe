<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter Android dry run

This unreleased sample checks the Android method-channel bridge and captures two masked Flutter renderer frames after a real tap. The native reporter, Flutter replay buffer, and report outbox are still separate. No report submission is exercised.

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

The app uses a throwaway key unless `EVERFRAME_APP_ID` and `EVERFRAME_SDK_KEY` are supplied as Dart defines. The bridge accepts only the development environment and starts the native SDK with screenshots and automatic crash capture disabled. Its `Start dry run` button invokes the native SDK; `Open reporter` invokes the native UI. The integration test only checks method-channel start/context/kill routing and the masked Flutter A/B frames. Native replay may still be enabled by server configuration, so use only a throwaway project for this probe. The reporter open/cancel/submit path, platform-view handling, Dart error capture, network hooks, Flutter SDK identity, offline retry, and dashboard delivery remain unverified.
