<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Release health

Release health answers one question: is the version you just shipped crashing
more than the one before it? For every version of your native and web apps, Everframe counts
foreground sessions on Android and iOS (including React Native, Flutter, and KMP), plus native tvOS and Vega,
and page sessions on web.
It shows how many completed without an observed crash. Each project has a **Release health** page, with one row per
version and a page for each version.

## Set up

Release health is on by default in the Android, iOS/tvOS and React Native SDKs, and
the SDK reads the app version and build itself. Ship a release build: sessions
appear after the app has been in the foreground and the SDK has sent them.

Debug builds aren't counted, so crashes during development never lower a
version's rate. The SDK records nothing from a debug build and logs
`[everframe] Release health is off in debug builds.` once per start:

- **Android:** an app whose `debuggable` flag is set, as Android Studio's debug
  build type sets it.
- **iOS/tvOS:** an app running in the simulator, or one signed with a development
  profile (`get-task-allow`), as Xcode signs Debug builds run on a device.
  TestFlight, App Store, ad hoc and enterprise builds all count.

Release builds that run outside the store count too, such as Android release
builds on emulators or in CI end-to-end runs, and iOS ad hoc QA builds. To
leave them out, turn release health off with your own CI or QA flag.

To count debug builds too, for example while you check your setup, set
`includeDebugBuilds`:

```kotlin
releaseHealth = ReleaseHealthConfig(includeDebugBuilds = true),
```

```swift
EverframeConfig(sdkKey: sdkKey, releaseHealth: ReleaseHealthConfiguration(includeDebugBuilds: true))
```

```tsx
releaseHealth: { includeDebugBuilds: true },
```

`includeDebugBuilds` applies to the configuration it is set on. On iOS/tvOS, a
configuration you pass to `setReleaseHealth` needs `includeDebugBuilds: true`
again, or a debug build is skipped.

To turn release health off:

```kotlin
releaseHealth = null,
```

```swift
EverframeConfig(sdkKey: sdkKey, releaseHealth: nil)
```

```tsx
releaseHealth: { enabled: false },
```

Per platform:

- **Android** opens sessions in the app's default process only, through AndroidX
  App Startup's `ProcessLifecycleInitializer`. It is there unless you removed it
  from the manifest; without it no session opens and the SDK logs
  `process-lifecycle-unavailable`. `Everframe.isReleaseHealthReady()` is true
  while a foreground session is being recorded.
- **iOS/tvOS:** `Everframe.shared.start` applies `EverframeConfig.releaseHealth`.
  `setReleaseHealth(_:)` changes it while the app runs, until the next `start`,
  and returns `true` once a foreground session has started. tvOS uses the same
  collector and appears under its own platform badge and filter. Use the existing
  iOS integration SDK key for Apple TV apps; iOS and tvOS sessions remain separate
  under the runtime filter even when they share that key and version.
- **React Native** reports through the Android and iOS SDKs, so use the Provider
  option and not the native calls. It needs the Hermes bundle identity that
  `@everframe/metro` adds at build time, or the `jsBundle` option. Without one,
  release health stays off and the SDK logs an `[everframe]` warning: in
  development builds when you left `releaseHealth` out, and in every build when
  you set it. Every Provider configure applies its own setting.

## Web and React setup

Starting with SDK 1.2.2, web release health starts automatically when you supply
an explicit valid `appVersion` in a production build. Browser, Tizen, webOS,
Vega web runtimes, Vidaa, and TitanOS use the same producer. The separate native
Vega SDK is not part of this page-session collector.

```ts
import { init } from '@everframe/web';
init({ sdkKey: 'YOUR_SDK_KEY', appVersion: '12.3.5-12-web', debugBuild: false });
```

```tsx
import { EverframeProvider } from '@everframe/react';
<EverframeProvider config={{ sdkKey: 'YOUR_SDK_KEY', appVersion: '12.3.5-12-web', debugBuild: false }}>
  <App />
</EverframeProvider>
```

Use your build's production/debug setting for `debugBuild`; true suppresses web
health sessions and automatic releases. When unset, the existing SDK debug
build detection applies. Missing app versions do not create health releases.
`disabled`, SDK kill, and `crashReporting.disabled` turn collection off.
`reporter.disabled` keeps health collection active in crash-only mode.
Set `releaseHealth: { enabled: false }` to disable page health independently
of ordinary error reporting.

## Flutter and KMP

The Flutter and KMP bridges enable Android/iOS foreground sessions by default,
using the native SDK's app version, lifecycle, crash evidence, and debug gate.
Set `releaseHealth: false` on Flutter's `EverframeNativeBridge.start` or
`releaseHealth = false` on `EverframeKmpConfig` to opt out. Flutter's
`crash: false` also turns health off. Native sessions are anonymous in these
wrappers; `setUser` does not change their frozen health subject.

This first pass counts native process crashes and Android JVM crashes/ANRs.
Dart errors and handled Kotlin exceptions do not mark a session crashed. There
is no new automatic Dart error observer. The Flutter/KMP browser drivers reuse
web page sessions and their global-error rules, require the real host app
version, and forward the health opt-out and debug setting to `@everframe/web`.

See [Flutter setup](../packages/everframe_flutter/README.md#release-health) and
[KMP setup](../packages/everframe_kmp/README.md#release-health).

## Native Vega

`@everframe/vega` records anonymous foreground sessions by default when configured
with a valid `appVersion` and a production build. Set `releaseHealth: false` to
opt out; `enabled: false` disables the whole SDK, and `debugBuild: true` excludes
health collection. Use the Vega integration's SDK key. Browser Vega apps continue
using the web SDK and page sessions.

This collector targets the SDK's existing Vega OS 1.1 / React Native 0.72 support.
It observes AppState and keeps a session open while any app component is active.
An unknown lifecycle state does not create a completed session. Only a fatal
`ErrorUtils` JavaScript error carrying the frozen foreground session identity
counts as a crash. Handled errors, non-fatal errors and promise rejections do not
change the crash rate. Native/C++ crashes, engine aborts, ANRs, watchdog kills and
power loss are not detected; an absent completion remains unknown.

Session delivery uses a separate queue in the supplied AsyncStorage. As with
Vega crash reports, storage and delivery are best effort; an abrupt exit may
interrupt them. Sessions are anonymous even if `setUser` was called. See the
[Vega SDK setup](../packages/sdk-vega/README.md) for lifecycle requirements and
queue behavior.

## What a crash-free session is

A crash-free session has an observed completion and no qualifying crash. Native
apps use foreground sessions; web apps use page sessions.

A native session starts when your app comes to the foreground and ends when it goes to
the background. A session that reaches the background is **completed**. A
session **crashed** when the app crashed during it, from any of these causes:

- a native crash (C, C++, Swift or Objective-C) on Android, iOS or tvOS;
- an uncaught Kotlin or Java exception on Android;
- a fatal JavaScript error that ends a React Native or native Vega app (Hermes);
- app not responding on Android: the system ended the app because it stopped
  responding (an ANR, reported on Android 11 and later).

On web, a session starts when the SDK initializes in a document. SPA navigation,
React remounts, hiding the tab, and back/forward-cache restoration do not start
another session. A full document reload does. A non-cached page exit reports
completion. The first global uncaught exception or unhandled promise rejection
marks that session crashed immediately, even if the page continues running.
Handled exceptions, console errors, resource-load errors, and errors caught by
React boundaries do not count. A later completion cannot undo a failure.

An open TV page can report sessions before it has a resolved outcome. Closing a
browser, losing power, or losing the exit request may leave an unknown outcome;
these are never inferred to be crashes or successful completions. Exit delivery
is best effort and queued observations retry when possible. These measurements
cover the time the SDK observes, not time before SDK initialization or a verified
browser-process crash rate. Runtime platform is detected separately from the
version string; versions are kept exactly as supplied.

For web user rates, only a valid explicitly supplied user ID available at session
start is frozen into that session. Later identity changes do not rewrite it.
Anonymous sessions do not become synthetic users.

Crash-free sessions = completed ÷ (completed + crashed).

Sessions with an unknown outcome are left out of both sides; see
[unknown outcomes](#unknown-outcomes). A version shows a rate once it has at
least 20 completed or crashed sessions. With fewer, the page says "Too few
sessions" instead of a number that a single crash could swing.

A version is "Below target" when it has at least the alert rule's minimum of
completed or crashed sessions and its rate is under the rule's target. Without a
rule, the target is 99% and the minimum 100 sessions. A rate exactly at the
target is not below it. The page applies this to the period and platform you're
looking at; the alert applies it to the last 7 days across all platforms. Both
use the same rate.

Each crashed session counts once, under one cause. When a session has more than
one, "What crashed" uses the first of: native crash, Kotlin or Java crash,
JavaScript crash, app not responding.

These don't count as crashes:

- a crash after the app went to the background, because its session had
  already completed;
- a handled error or a handled promise rejection. Unhandled rejections count
  as crashes on web.

"Last 7 days" and "Last 30 days" are rolling periods that end now. The daily
chart uses UTC days. The platform filter covers iOS, tvOS, Android, Web, Tizen, webOS,
Vega, Vidaa and TitanOS.

## Unknown outcomes

Some sessions end without the SDK learning how:

- the user force-quit the app, or the device shut down or restarted;
- the system ended the app to free memory (a low-memory kill), including the
  low-memory, unresponsive and unexplained terminations that the iOS/tvOS SDK infers
  on the next launch. On Android, a low-memory kill while the app was visible
  still appears under Errors as a "Low memory kill" crash, but its session
  counts as unknown;
- the app crashed in a way the SDK couldn't tie to the session: before the
  session start was saved, or a React Native JavaScript error raised from a
  JavaScript bundle other than the one the session started with;
- the session's records were lost: the device stayed offline past the seven-day
  retry window, the queue on the device was full, or storage failed.

These sessions count as neither completed nor crashed, so they don't move the
rate either way. The version page shows the share of sessions with a known
outcome. A low share means the rate rests on fewer sessions than the total
suggests.

## Why set a user ID

Without a user ID every session is anonymous, and the page can count sessions
but not people. With one, it also shows:

- **Crash-free users**: of the users whose outcome is known, the share who
  didn't crash. A user crashed when any of their sessions crashed, and is
  crash-free when none of their sessions crashed and at least one completed.
  A user whose sessions all ended with an unknown outcome isn't counted.
- **Users affected**: how many users had at least one crashed session.

Crash-free users needs at least 80% of a version's sessions to carry a user ID,
and at least 20 users with a known outcome. Below that the page says "Set a
user ID to see this" or "Too few users" instead of a number.

Use your own opaque account ID, never an email address or a name. It must be
non-blank, at most 128 UTF-16 code units and free of control characters
(U+0000 to U+001F) and unpaired surrogates. The SDK never copies it from
`setUser`.

- **Android:** `ReleaseHealthConfig(userId = accountId)`. On login, logout or an
  account switch, call `Everframe.start` again with the new value
  (`userId = null` on logout). An invalid ID keeps release health off; nothing
  is thrown.
- **iOS/tvOS:** `releaseHealth: try ReleaseHealthConfiguration(userId: accountId)` in
  `EverframeConfig`, then `setReleaseHealth` whenever the account changes
  (`ReleaseHealthConfiguration()` on logout). An invalid ID throws
  `ReleaseHealthConfiguration.ValidationError.invalidUserIdentity`.
- **React Native:** `releaseHealth: { userId: accountId }`. Remount the Provider
  with a changed `key` when the ID changes; changing the `config` prop alone
  does nothing. An invalid ID logs a warning and turns release health off.

Changing the ID ends the current session and starts a new one. A session keeps
the ID it started with. The part of a session before an ID change ends as a
completed session, so an app that learns the ID after launch adds one
crash-free session per launch. When the ID is known at start, pass it in the
start configuration instead: `ReleaseHealthConfig(userId = …)` in
`EverframeConfig` on Android, `releaseHealth: try ReleaseHealthConfiguration(userId: …)`
in `EverframeConfig` on iOS/tvOS, and `releaseHealth: { userId }` at first mount on
React Native.

## Versions and builds

For Android, Apple and React Native apps, the SDK reads the app version:

- **Android:** `versionName`, trimmed. When it is missing, blank, longer than 64
  UTF-16 code units or holds control characters, the SDK uses `versionCode` as
  text instead, and `0.0.0` only when it can't read the package at all. The
  build is `versionCode`.
- **iOS/tvOS:** `CFBundleShortVersionString`, trimmed, else `CFBundleVersion`, else
  `0.0.0`. The build is `CFBundleVersion`, or none.
- **React Native:** the native app's version and build, read as above. An
  over-the-air JavaScript update keeps the native version, so its sessions count
  toward that version.

Web and native Vega apps supply `appVersion` and optional `appBuild` explicitly.

Crash and error reports carry the same version in `context.app.version`. That is
how a version's "New errors" (error groups first seen in it) and "Top errors"
match its sessions. Every release build of a version counts toward the version,
and the version page lists the builds it has seen. Debug builds aren't counted
(see [Set up](#set-up)).

On iOS/tvOS, `EverframeConfig(release:)` overrides the version of native crash
reports. If you set it, native crashes (Mach exceptions and signals) and the
terminations the SDK infers on the next launch report under that value instead
of the app version. Release health keeps using the app version, so those crashes
still count against the right session, but their errors show up under "New
errors" and "Top errors" only for a version that matches `release`. Leave
`release` unset, or set it to the app version, to keep them together.

A version can be any text up to 64 UTF-16 code units, such as `2.4.0`,
`2.4.0+42` or `1.0 (beta)`. Two different strings are two versions.

"First seen" is the start of the earliest session of that version that
Everframe has received. It is kept after the sessions themselves expire, so a
version shipped months ago keeps its first-seen day. For a version already in use
before its sessions started arriving, it is the first session Everframe received.
The latest release is the version first seen most recently, and the page
compares it with the version first seen before it.

## Privacy and delivery

Release health is separate from replay, vitals, `setUser` and install
identifiers. A session record holds the app version and build, the platform, the
SDK version, the loaded JavaScript bundle ID in React Native apps, the start
time and length, and the user ID if you set one. It holds no device or install
identifier.

The Android and Apple SDKs save each session start to an encrypted, app-private queue before they
tie crash reports to that session. The queue keeps at most 256 records and
1 MiB, for seven days. When it is full, the SDK refuses new records rather than
dropping older ones. Retries resend each record's original bytes to its original
SDK key and endpoint. Session records are sent independently of crash and error
reports, which have their own queue.

Web and React keep pending session records in origin-local `localStorage`, without
additional encryption, or memory when storage is unavailable. The web queue holds
at most 128 records and 1 MiB, expires records after 30 days, and evicts the oldest
records first when full. A failed storage write or lost exit request can leave an
unknown session. Only initialize with user IDs you intend to include in telemetry.
`kill()`, disabling the SDK or crash reporting, and switching to a debug build
stop web health delivery and erase pending records for that SDK key and endpoint.

Turning release health off erases the records still waiting on the device:
`releaseHealth = null` or `ReleaseHealthConfig(enabled = false)` on Android,
`releaseHealth: nil` or `setReleaseHealth(nil)` on iOS/tvOS, `enabled: false` in
React Native, a debug build that isn't counted, and `kill()` on Android, iOS and tvOS.
Records Everframe has already received are not recalled; they expire after 30
days. Crash reports already captured keep their own delivery and retention.

## Alerts

A project can send a webhook when a version drops below a crash-free target.
See [release health alerts](release-health-alerts.md).
