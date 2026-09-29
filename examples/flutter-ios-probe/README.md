<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter iOS dry run

This unreleased sample compiles the Flutter method-channel bridge against the local Everframe Swift package and checks masked Flutter A/B frames on an iOS simulator. It submitted reports with masked screenshots and replay to both a loopback fake ingest and a local API/dashboard. See `docs/dry-runs/flutter-ios-native-bridge.md` and `docs/dry-runs/flutter-kmp-local-dashboard-e2e.md` for evidence and limits.

From the public repository root, set `EVERFRAME_SDK_IOS_ROOT` to the **absolute** path of `packages/sdk-ios`. Flutter places the plugin in a generated Swift Package Manager directory, so a relative SDK path resolves incorrectly. Then:

```sh
cd examples/flutter-ios-probe
flutter pub get
flutter test
flutter analyze
EVERFRAME_SDK_IOS_ROOT=/absolute/path/to/everframe/packages/sdk-ios flutter build ios --simulator --debug --no-codesign
EVERFRAME_SDK_IOS_ROOT=/absolute/path/to/everframe/packages/sdk-ios flutter test integration_test/ios_probe_test.dart -d <simulator-id>
```

The sample sets `EverframeDevIngestURL` to `http://127.0.0.1:8787`, and the plugin refuses to start if the SDK endpoint is not loopback. Supply a real key from a disposable local dashboard app through `EVERFRAME_APP_ID` and `EVERFRAME_SDK_KEY` Dart defines to authorize a report; the built-in fake key remains for bridge-only tests. Additional native screenshots and automatic crash capture are disabled. This sample proves privacy only for registered Flutter pixels in the tested scene.

`Record Dart context` explicitly stores a handled Dart error and adds an origin-only network breadcrumb. The integration test checks start/context/kill routing, handled-error storage acknowledgement, and two masked Flutter frames after a tap. A local dashboard submission confirmed the reporter, handled-error delivery, Flutter SDK identity, masked screenshot, and replay. Embedded platform views, automatic Dart error and network hooks, offline retry, and real devices remain unverified.
