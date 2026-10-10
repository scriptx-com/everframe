<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe Flutter

[`everframe_flutter`](https://pub.dev/packages/everframe_flutter) is the
Everframe plugin for Flutter apps on Android, iOS, and web. Create a **Flutter**
integration in the Everframe dashboard to get its app ID and SDK key.

## Install

```sh
flutter pub add everframe_flutter
```

The plugin requires Flutter 3.47+ and Dart 3.13+, with Android API 24+ or
iOS 15+ on the respective host platform.
Its Android bridge resolves the native Everframe 0.10.x modules; the iOS bridge
requires native Everframe 1.0.0 or newer. Android hosts must use
`FlutterFragmentActivity` for the Compose reporter and declare the `INTERNET`
permission for release builds. The native SDK owns the ingest endpoint;
published binaries use the production endpoint.

## Send a report

```dart
import 'package:everframe_flutter/everframe_flutter.dart';
import 'package:flutter/widgets.dart';

final everframe = EverframeNativeBridge();
await everframe.start(
  appId: '<Flutter integration app ID>',
  sdkKey: '<Flutter integration SDK key>',
  environment: 'production',
);
```

Wrap the Flutter content you want to capture in a `RepaintBoundary`. Register
every private widget with `EverframeSensitive`, using the same
`SensitiveRegionRegistry` that you pass to `openReporter`:

```dart
final boundaryKey = GlobalKey();
final sensitiveRegions = SensitiveRegionRegistry();

Widget capturedScreen() => RepaintBoundary(
  key: boundaryKey,
  child: EverframeSensitive(
    registry: sensitiveRegions,
    child: const Text('Private content'),
  ),
);

Future<void> report() async {
  await everframe.openReporter(
    boundaryKey: boundaryKey,
    sensitiveRegions: sensitiveRegions,
  );
}
```

The bridge masks registered regions before encoding the screenshot and fails
closed when masking geometry or capture is unavailable. To attach replay when
enabled for the app, sample masked frames with `SafeReplayRecorder` and
`captureRegisteredFrameAfterFrame`, then pass its frozen `SafeReplayBuffer` to
`openReporter`. Replay is bounded, image-based, and kept in memory until a
report. See the [Android](../../examples/flutter-android-probe) and
[iOS](../../examples/flutter-ios-probe) source probes for complete examples.

`captureException(error, stackTrace: stack)` explicitly stores a handled Dart
error in the native encrypted outbox; its boolean result confirms local
storage, not server delivery. `recordNetwork` is an opt-in breadcrumb for HTTP
method, URL origin, status, and optional duration. Call it from your own HTTP
wrapper. The plugin does not automatically intercept Dart errors or HTTP
requests, and native platform views outside the Flutter capture boundary are
not included. The same integration key works on Android and iOS; reports still
identify their host platform.

The bridge starts the native SDK with crash capture on. On Android that covers JVM
exceptions, native crashes and ANRs (Android 11+), and the native SDK then owns
`ActivityManager.setProcessStateSummary` in the app's main process; do not call it
from your app. See the [Android SDK guide](../sdk-android/README.md#crash-capture-on-by-default).

The Android and iOS simulator samples submitted masked screenshots and replay
to a local dashboard. Physical-device behavior, production delivery, and
offline retry after process restart remain unverified. Flutter web's masked
screenshot, image replay, reporter, and retry paths passed Chromium probes.
macOS remains an unreleased probe.

## Flutter web

Add `EverframeWebCapture` after the first frame with the same
`RepaintBoundary` and `SensitiveRegionRegistry` used for native capture.
It refuses capture when no sensitive widgets are registered unless you opt in
to an explicitly known-safe screen with `allowUnmarked: true`. Call
`EverframeWebBridge.start` with the Flutter integration key, then use its
`openReporter`, `setUser`, `recordScreen`, `addBreadcrumb`, and
`captureException` methods from Dart. The bridge uses `@everframe/web` in the
browser and preserves `everframe-flutter` attribution.

```dart
import 'dart:async';
import 'package:flutter/widgets.dart';
import 'package:everframe_flutter/everframe_flutter.dart';

final capture = EverframeWebCapture(
  boundaryKey: boundaryKey,
  sensitiveRegions: sensitiveRegions,
);
WidgetsBinding.instance.addPostFrameCallback((_) {
  capture.install();
  unawaited(const EverframeWebBridge().start(
    sdkKey: flutterIntegrationKey,
    appVersion: '1.0.0',
  ));
});
```

The browser host loads `@everframe/web` as a module and exposes its initializer
before or after Flutter boots; the Dart bridge waits for the ready event:

```js
import { init } from '/sdk/index.js';
import { flutterVisualCapture } from './assets/packages/everframe_flutter/assets/visual_capture.js';
window.everframeFlutterInit = (config) => init({
  ...config,
  visualCapture: flutterVisualCapture(),
});
window.dispatchEvent(new Event('everframe-flutter-web-sdk-ready'));
```

Bundle `@everframe/web` from npm or use its published browser ESM artifact
at `/sdk/index.js`; this path in the snippet is the host's own served asset.
Use the matching dashboard Flutter key. The browser reporter owns network
delivery and retry; Flutter owns masked renderer pixels. No screen-recording
permission or DOM screenshot fallback is involved. The complete runnable
source is in [the Flutter web probe](../../examples/flutter-web-probe).

Contributors can build against local native source with
`-PeverframeNativeVersion=0.10.0-DEV` on Android or
`EVERFRAME_SDK_IOS_ROOT=/absolute/path/to/packages/sdk-ios` on iOS. Customer
apps use the published package without these overrides.
