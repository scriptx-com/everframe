<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Release health

Release health answers one question: is the version you just shipped crashing
more than the one before it? For every version of your Android, iOS and React
Native apps, Everframe counts foreground sessions and shows how many ended
without a crash. Each project has a **Release health** page, with one row per
version and a page for each version.

## Set up

Release health is on by default in the Android, iOS and React Native SDKs, and
the SDK reads the app version and build itself. Ship a release build: sessions
appear after the app has been in the foreground and the SDK has sent them.

Debug builds aren't counted, so crashes during development never lower a
version's rate. The SDK records nothing from a debug build and logs
`[everframe] Release health is off in debug builds.` once per start:

- **Android:** an app whose `debuggable` flag is set, as Android Studio's debug
  build type sets it.
- **iOS:** an app running in the simulator, or one signed with a development
  profile (`get-task-allow`), as Xcode signs Debug builds run on a device.
  TestFlight, App Store, ad hoc and enterprise builds all count.

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

`includeDebugBuilds` applies to the configuration it is set on. On iOS, a
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
- **iOS:** `Everframe.shared.start` applies `EverframeConfig.releaseHealth`.
  `setReleaseHealth(_:)` changes it while the app runs, until the next `start`,
  and returns `true` once a foreground session has started. tvOS doesn't collect
  release health.
- **React Native** reports through the Android and iOS SDKs, so use the Provider
  option and not the native calls. It needs the Hermes bundle identity that
  `@everframe/metro` adds at build time, or the `jsBundle` option. Without one,
  release health stays off and the SDK logs an `[everframe]` warning: in
  development builds when you left `releaseHealth` out, and in every build when
  you set it. Every Provider configure applies its own setting.

## What a crash-free session is

A crash-free session is a foreground session that didn't end in a crash.

A session starts when your app comes to the foreground and ends when it goes to
the background. A session that reaches the background is **completed**. A
session **crashed** when the app crashed during it, from any of these causes:

- a native crash (C, C++, Swift or Objective-C) on Android or iOS;
- an uncaught Kotlin or Java exception on Android;
- an unhandled JavaScript error that ends a React Native app (Hermes);
- app not responding on Android: the system ended the app because it stopped
  responding (an ANR, reported on Android 11 and later).

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
- a handled error or a promise rejection. The SDK reports those under Errors
  instead.

"Last 7 days" and "Last 30 days" are rolling periods that end now. The daily
chart uses UTC days. Web apps don't report sessions, because a browser tab
can't report how it ended; their problems show up under Errors.

## Unknown outcomes

Some sessions end without the SDK learning how:

- the user force-quit the app, or the device shut down or restarted;
- the system ended the app to free memory (a low-memory kill), including the
  low-memory, unresponsive and unexplained terminations that the iOS SDK infers
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
- **iOS:** `releaseHealth: try ReleaseHealthConfiguration(userId: accountId)` in
  `EverframeConfig`, then `setReleaseHealth` whenever the account changes
  (`ReleaseHealthConfiguration()` on logout). An invalid ID throws
  `ReleaseHealthConfiguration.ValidationError.invalidUserIdentity`.
- **React Native:** `releaseHealth: { userId: accountId }`. Remount the Provider
  with a changed `key` when the ID changes; changing the `config` prop alone
  does nothing. An invalid ID logs a warning and turns release health off.

Changing the ID ends the current session and starts a new one. A session keeps
the ID it started with.

## Versions and builds

A release is an app version. The SDK reads it, and you don't pass it:

- **Android:** `versionName`, trimmed. When it is missing, blank, longer than 64
  UTF-16 code units or holds control characters, the SDK uses `versionCode` as
  text instead, and `0.0.0` only when it can't read the package at all. The
  build is `versionCode`.
- **iOS:** `CFBundleShortVersionString`, trimmed, else `CFBundleVersion`, else
  `0.0.0`. The build is `CFBundleVersion`, or none.
- **React Native:** the native app's version and build, read as above. An
  over-the-air JavaScript update keeps the native version, so its sessions count
  toward that version.

Crash and error reports carry the same version in `context.app.version`. That is
how a version's "New errors" (error groups first seen in it) and "Top errors"
match its sessions. Every release build of a version counts toward the version,
and the version page lists the builds it has seen. Debug builds aren't counted
(see [Set up](#set-up)).

On iOS, `EverframeConfig(release:)` overrides the version of native crash
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

The SDK saves each session start to an encrypted, app-private queue before it
ties crash reports to that session. The queue keeps at most 256 records and
1 MiB, for seven days. When it is full, the SDK refuses new records rather than
dropping older ones. Retries resend each record's original bytes to its original
SDK key and endpoint. Session records are sent independently of crash and error
reports, which have their own queue.

Turning release health off erases the records still waiting on the device:
`releaseHealth = null` or `ReleaseHealthConfig(enabled = false)` on Android,
`releaseHealth: nil` or `setReleaseHealth(nil)` on iOS, `enabled: false` in
React Native, a debug build that isn't counted, and `kill()` on Android and iOS.
Records Everframe has already received are not recalled; they expire after 30
days. Crash reports already captured keep their own delivery and retention.

## Alerts

A project can send a webhook when a version drops below a crash-free target.
See [release health alerts](release-health-alerts.md).
