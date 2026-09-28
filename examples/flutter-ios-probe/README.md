<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter iOS dry run

This unreleased sample compiles the Flutter method-channel bridge against the local Everframe Swift package and checks masked Flutter A/B frames on an iOS simulator. The safe frame buffer is not yet attached to native reports.

From the public repository root, set `EVERFRAME_SDK_IOS_ROOT` to the **absolute** path of `packages/sdk-ios`. Flutter places the plugin in a generated Swift Package Manager directory, so a relative SDK path resolves incorrectly. Then:

```sh
cd examples/flutter-ios-probe
flutter pub get
flutter test
flutter analyze
EVERFRAME_SDK_IOS_ROOT=/absolute/path/to/everframe/packages/sdk-ios flutter build ios --simulator --debug --no-codesign
EVERFRAME_SDK_IOS_ROOT=/absolute/path/to/everframe/packages/sdk-ios flutter test integration_test/ios_probe_test.dart -d <simulator-id>
```

The sample sets `EverframeDevIngestURL` to `http://127.0.0.1:8937`, and the plugin refuses to start if the SDK endpoint is not loopback. The fake 41-character key is accepted by the current iOS SDK validator but cannot authorize a report. Native screenshots and automatic crash capture are disabled. Use only a throwaway project for further tests: server-controlled native replay privacy is not yet proven for Flutter.

The integration test checks start/context/kill routing and two masked Flutter frames after a tap. It does not prove native reporter open/cancel/submit, Dart error capture, network hooks, offline retry, SDK identity, or dashboard delivery.
