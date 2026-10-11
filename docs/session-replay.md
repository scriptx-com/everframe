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
- **Length:** the last 15, 30 or 60 seconds.
- **Frame rate** (native video): 1, 2, 5 or 10 frames per second. The server
  default is 2 for SDKs that support these rates; older SDKs receive 5. The
  iOS SDK's local fallback is still 5 if the server omits the native-video
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
