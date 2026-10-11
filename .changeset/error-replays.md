---
"@everframe/sdk-android": minor
"@everframe/sdk-ios-marker": minor
"@everframe/react-native": minor
"@everframe/web": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Errors can carry a session replay.

When replay is on, a handled error, and on React Native and the web an error
the app survives, can carry the last seconds of replay from a recording
session. There are at most 2 per session, including exports in progress. An
open bug report that owns the buffer prevents an error replay. A replay that
isn't ready within 3 seconds or is over 8 MB (8,000,000 bytes) is left off.
Replay failure doesn't discard the original error: Android and iOS save it
first with a hold of up to 5 seconds; the web queues it first and waits up to
3 seconds before sending. Android and iOS take an independent snapshot while
recording continues, so a later error or bug report still has the history.
Fatal native and React Native errors and Flutter apps don't attach error
replays. Web error replays require `CompressionStream`.

Native video replay adds 1 and 2 frames per second, with 2 as the server
default for SDKs that support it. The iOS fallback remains 5 fps when the
server omits the native-video setting; Android requires that setting to record
native video. The bitrate scales down below 5 fps. Recording now also pauses
in iOS Low Power Mode, in Android Battery
Saver and at Android's `MODERATE` thermal status or higher (Android 10+), and
never starts on Android low-RAM devices. Web recording pauses while the tab
is hidden.

Web replay masks form input values again, leaves out elements marked
sensitive, and removes recognized card-number, JWT, bearer-token and
email-address patterns, while other text stays readable. Sensitive markers
added during recording also apply.

See [session replay](../docs/session-replay.md) for settings and privacy
boundaries.
