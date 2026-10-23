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
Both native bridges require native Everframe 1.2.1 or later in 1.2.x: the Android bridge resolves the
`dev.everframe` 1.2.x modules, and the iOS bridge requires `Everframe` 1.2.x, the
first release with `EverframeConfig(sdkKey:)` and `EverframeConfig(releaseHealth:)`.
Android hosts must use `FlutterFragmentActivity` for the Compose reporter and
declare the `INTERNET` permission for release builds. The native SDK owns the
ingest endpoint; published binaries use the production endpoint.

## Release health

Release health is on by default. Android and iOS use the existing native
foreground-session collectors and read the app version/build from the installed
application. Native crashes (and Android JVM crashes/ANRs) affect the crash-free
rate. Dart errors, including `captureException`, do not affect it in this first
pass; no automatic Dart error hooks are installed.

```dart
await const EverframeNativeBridge().start(
  appId: 'YOUR_APP_ID',
  sdkKey: 'YOUR_SDK_KEY',
  releaseHealth: false, // Optional: disable health while keeping crash reports.
);
```

`crash: false` disables both native crash capture and health collection. Debug
builds do not report health; leave `debugBuild` unset for native detection or
pass the host build flag explicitly. `kill()` stops collection. Native sessions
are anonymous in this wrapper: `setUser` does not identify their health records,
so the dashboard shows session rates rather than crash-free user rates.

The browser bridge uses `@everframe/web` 1.2.2 or later for page sessions. It
requires an explicit host `appVersion` and forwards `debugBuild` and
`releaseHealth` (default true). Setting `releaseHealth: false` leaves browser
error reporting enabled. Identical repeated starts reuse the collector; changed
settings destroy and replace it. Browser global uncaught exceptions/rejections
follow the web measurement rules; framework-caught Dart errors do not become
health failures. See [how release health is measured](../../docs/release-health.md).

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
from your app. Pass `crash: false` to `start` to turn crash capture off on Android
and iOS; that also turns off `captureException`. See the [Android SDK guide](../sdk-android/README.md#crash-capture-on-by-default).

The Android and iOS simulator samples submitted masked screenshots and replay
to a local dashboard. Physical-device behavior, production delivery, and
offline retry after process restart remain unverified. Flutter web's masked
screenshot, image replay, reporter, and retry paths passed Chromium probes.
macOS remains an unreleased probe.

## Quick capture

In a debug iOS simulator or Android emulator, simulator quick capture files a
report from a hotkey or `npx @everframe/cli capture`, with no reporter UI.
Flutter masks in Dart, so the native SDK never takes its own screenshot in a
Flutter app. It ignores quick capture until you supply the masked Flutter frame:

```dart
await everframe.enableQuickCapture(
  boundaryKey: boundaryKey,
  sensitiveRegions: sensitiveRegions,
  replayBuffer: replayBuffer, // optional; a snapshot of its masked frames
);
```

Call it after `start`. Each capture then sends the same masked screenshot and
replay `openReporter` would send. If the masked frame can't be produced safely,
the capture fails and no image is sent. A live recording buffer is not frozen.
`disableQuickCapture()` removes the registration. Pass `quickCapture: false` to
`start` to opt out entirely. Devices and release builds are unaffected.

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
