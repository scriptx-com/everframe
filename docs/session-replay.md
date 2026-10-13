<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Session replay

Session replay shows the last few seconds of what a user saw before they sent a
bug report or hit an error. It records on Android, iOS, tvOS, React Native and
the web.

## Turn it on

Replay is off until you turn it on for an app in the dashboard, under the app's
**Session replay** settings. There you choose:

- **Sampling:** the share of sessions that record. A session is one SDK
  `start` on mobile (normally an app launch) and one page load on the web.
  Each session is picked at random. The dashboard suggests 10% when you first
  turn replay on. Sessions that aren't picked don't record replay.
- **Crash-only sessions:** a second sampling rate, for sessions where the app
  turned the bug reporter off. See [Crash-only sessions](#crash-only-sessions).
- **Length:** the last 15, 30 or 60 seconds.
- **Frame rate** (native video): 1, 2, 5 or 10 frames per second. The server
  default is 2 for SDKs that declare the low rates (`nativevideolowfps`) and 5
  for those that do not. The iOS SDK's local fallback is still 5 if the server omits the native-video
  setting; Android requires that setting to record native video.
  Lower rates capture fewer frames and use a lower encoding bitrate below
  5 fps; 5 or 10 capture more of quick taps and scrolling.

## How it records

A recording session keeps a rolling buffer of the last few seconds on the
device. Replay bytes aren't uploaded until a bug report or an error needs them.

- **Android, iOS and tvOS** record video (H.264) of the app's screen, at most
  854 pixels on its longest edge.
- **React Native** records through the Android and iOS SDKs, including tvOS.
- **The web** records page changes, not pixels.

Recording pauses on its own, discarding the old buffer. It starts a fresh
buffer when recording resumes:

- **iOS and tvOS:** in the background, on a memory warning, and at serious or
  critical thermal states. iOS also pauses in Low Power Mode.
- **Android:** without window focus, in Battery Saver, and at `MODERATE`
  thermal status or higher (Android 10+). Low-RAM devices never record.
- **Web:** while the tab is hidden.

## What is hidden

- **Android:** text fields, views you mark as sensitive, and `TextureView`s
  are blacked out. `SurfaceView` content isn't captured; controls and other
  views above it remain visible. Secure windows and frames containing visible
  web views, Compose or Flutter content aren't recorded. Frames are also
  refused when the SDK can't prove where sensitive content is drawn. See the
  [native video privacy boundaries](../packages/sdk-android/android/README.md#native-video-privacy-boundaries).
- **iOS and tvOS:** views you mark as sensitive, web views, and Metal, OpenGL
  and video layers are blacked out. Mark private text fields and any other
  private content as sensitive; ordinary text fields aren't masked automatically.
- **React Native:** wrap private content in `<EverframeSensitive>`. The
  native platform's privacy boundaries still apply.
- **Web:** form input values are masked, elements you mark as sensitive are
  left out, and recognized card-number, JWT, bearer-token and email-address
  patterns are removed from recorded content. Other text stays readable.
  Mark private content with `data-everframe-sensitive` or
  `sensitiveRegistry.addRef(element)`, including after recording has started.

## Replays on errors

When replay is on, an eligible error in a recording session can carry the
replay that led up to it, so the error page can play it.

- **Which errors:**
  - handled errors you report (`captureException`);
  - on React Native and the web, JavaScript errors and unhandled promise
    rejections the app survives;
  - on the web, React render errors that no error boundary catches, while
    the page keeps running.
- **Not included:** fatal native or React Native errors, crashes that end
  the app, recovered hangs, OS diagnostics, inferred terminations, and
  Flutter apps.
- **Limits:**
  - at most 2 error replays per session; exports in progress count against
    this limit;
  - an open bug report that owns or has frozen the buffer prevents an error
    replay;
  - a replay that isn't ready within 3 seconds, or is larger than 8 MB
    (8,000,000 bytes), is left off and the error is marked as having an
    omitted replay;
  - on the web, error replays need a browser that supports `CompressionStream`.
    User bug reports keep their compression fallback.
- **Replay failure doesn't discard the original error.** Android and iOS
  save the error first, holding it for up to 5 seconds while a replay is added.
  The web queues the error first and waits up to 3 seconds for its replay
  before sending it. Normal error-storage and delivery rules still apply.
- **Recording continues:** taking an error replay keeps the rolling buffer,
  so a later error or bug report still has the recording's history.
- **Kept per error:** Everframe keeps the replays of the 10 most recent
  occurrences of each error that have a replay.

Error replays record users who didn't choose to send a report. If you turn
replay on, say so in your app's privacy policy.

## Crash-only sessions

An app can turn the bug reporter off and keep crash and error reporting, for
example in production builds. A session started that way is a crash-only
session.

| SDK                      | Setting                                        |
| ------------------------ | ---------------------------------------------- |
| Web, React, React Native | `reporter: { disabled: true }`                 |
| iOS                      | `reporterEnabled: false` on `EverframeConfig`  |
| Android                  | `reporterEnabled = false` on `EverframeConfig` |

- **Two coverage rates.** The app's Session replay settings have one sampling
  rate for sessions that can file a report and one for crash-only sessions.
  The crash-only rate defaults to 0, so crash-only sessions don't record
  unless you raise it. An SDK whose server doesn't send the crash-only rate
  treats it as 0.
- **One draw per session.** Each session draws one random number and
  compares it with the rate for its kind. Once a rate has picked a session, a
  later change to that rate doesn't stop it.
- **Companion upgrade.** When a phone scans the companion QR code or a
  dashboard member attaches, the session uses the higher of the two rates for
  the rest of the session, so an upgrade never stops a recording. Recording
  starts at that moment, so a report filed through the companion has a replay
  from then on. Detaching doesn't undo the upgrade. A crash-only session that
  starts while a companion is still attached, for example after a restart or
  a React Native reconfigure, starts upgraded.
- **No reporter.** The hotkey, shake-to-report, the replies button and inbox,
  and `open()` stay off for the whole session, also after an upgrade.
  Reports from an upgraded session come through the companion. On the web
  and React Native, `open()` rejects with `EverframeReporterDisabledError`.
- **Network bodies** aren't captured in a crash-only session. After an
  upgrade they follow the app's settings.
- **Error replays follow recording.** An error carries a replay only while
  its session records. At the default crash-only rate of 0, errors from
  crash-only sessions carry no replay. At 5%, errors from about 5% of
  crash-only sessions can.

Crash and error capture, breadcrumbs, console logs, vitals, release health,
identity and the companion work the same in every session.
