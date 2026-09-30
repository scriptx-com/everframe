<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter Android dry run

This source probe checks the Android method-channel bridge, captures masked Flutter renderer frames, and passes them to the native reporter. It submitted a report with a masked screenshot and replay to both a loopback fake ingest and a local API/dashboard. These runs cover only the sample scene and emulator. Customer apps install the [published Flutter plugin](https://pub.dev/packages/everframe_flutter); this probe uses local source paths to test development builds.

The sample requires local `0.10.2-DEV` Android SDK artifacts. For emulator builds, use a local ingest address:

```sh
cd packages/sdk-android/android
EVERFRAME_DEV_INGEST_URL=http://10.0.2.2:8787 ./gradlew -Dmaven.repo.local=/tmp/everframe-flutter-android-m2 -PeverframeDevLocal=true :everframe-protocol:publishToMavenLocal :everframe-core:publishToMavenLocal :everframe-reporter-ui:publishToMavenLocal

cd ../../../examples/flutter-android-probe
flutter pub get
flutter test
flutter analyze
MAVEN_LOCAL_REPOSITORY=/tmp/everframe-flutter-android-m2 flutter build apk --debug
MAVEN_LOCAL_REPOSITORY=/tmp/everframe-flutter-android-m2 flutter test integration_test/android_probe_test.dart -d emulator-5554
```

The app uses a throwaway key unless `EVERFRAME_APP_ID` and `EVERFRAME_SDK_KEY` are supplied as Dart defines. This sample explicitly selects `development`; the bridge also accepts `staging` and `production`. `Start dry run` invokes the native SDK; `Open reporter` captures a masked Flutter screenshot and opens the native UI. `Record Dart context` explicitly stores a handled Dart error and adds an origin-only network breadcrumb. The integration test checks method-channel routing, handled-error storage acknowledgement, and masked Flutter A/B frames. The local dashboard report included masked screenshot and replay after replay was enabled in the app settings. Embedded platform views, automatic Dart error and network hooks, offline retry, and real devices remain unverified.
