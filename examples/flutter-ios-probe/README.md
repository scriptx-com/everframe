<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter iOS dry run

This unreleased sample compiles the Flutter method-channel bridge against the local Everframe Swift package and checks masked Flutter A/B frames on an iOS simulator. A local dry run submitted a report with a masked screenshot and replay to a loopback fake ingest. See `docs/dry-runs/flutter-ios-native-bridge.md` for the evidence and limits.

From the public repository root, set `EVERFRAME_SDK_IOS_ROOT` to the **absolute** path of `packages/sdk-ios`. Flutter places the plugin in a generated Swift Package Manager directory, so a relative SDK path resolves incorrectly. Then:

```sh
cd examples/flutter-ios-probe
flutter pub get
flutter test
flutter analyze
EVERFRAME_SDK_IOS_ROOT=/absolute/path/to/everframe/packages/sdk-ios flutter build ios --simulator --debug --no-codesign
EVERFRAME_SDK_IOS_ROOT=/absolute/path/to/everframe/packages/sdk-ios flutter test integration_test/ios_probe_test.dart -d <simulator-id>
```

The sample sets `EverframeDevIngestURL` to `http://127.0.0.1:8937`, and the plugin refuses to start if the SDK endpoint is not loopback. The fake 41-character key is accepted by the current iOS SDK validator but cannot authorize a report. Additional native screenshots and automatic crash capture are disabled. Use only a throwaway project for further tests; this sample proves privacy only for registered Flutter pixels in the tested scene.

`Record Dart context` explicitly stores a handled Dart error and adds an origin-only network breadcrumb. The integration test checks start/context/kill routing, handled-error storage acknowledgement, and two masked Flutter frames after a tap. Local manual submission exercised the reporter, handled-error delivery, and Flutter SDK identity. Embedded platform views, automatic Dart error and network hooks, offline retry, real devices, and dashboard delivery remain unverified.
