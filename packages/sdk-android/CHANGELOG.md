<!-- SPDX-License-Identifier: MIT -->

## 1.3.0

### Minor Changes

- a5e45fd: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Mobile crash reports now include the error's cause chain. React Native sends `Error.cause` chains through the existing native bridge, including the stacks Hermes exposes on `Error.prototype`. Android captures `Throwable` causes next to the existing JVM metadata, and iOS follows the `NSUnderlyingErrorKey` of `NSError` and `CustomNSError` errors. Each chain keeps at most 8 causes, 32 frames per cause and 65,536 serialized UTF-8 bytes, is redacted before it is stored, and marks anything it drops as truncated. Malformed cause data never discards the outer report, and causes do not change how errors are grouped.

  Cause redaction scans a bounded prefix of each field (8,192 characters) and of each JavaScript stack (32,768 characters). When either limit cuts the text, the cut token and any digit group before it are dropped before redaction, so a JWT, bearer token, card number or SSN split at the limit does not reach a report. The same holds for an email address when the web SDK's `redaction.maskInputs` includes `'email'`. This applies to web cause chains as well. Custom `redaction.customRules` patterns are matched only against the retained text, so when the limit cuts a custom match that contains spaces or other punctuation, the start of that match can remain unredacted.

- 18bcef7: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add report delivery diagnostics. `getReportDeliveryStatus()` in `@everframe/react-native`, `Everframe.getReportDeliveryStatus()` on Android and `Everframe.shared.getReportDeliveryStatus()` on iOS return a detached snapshot of cached observations: native capture outcomes per entry path, report outbox operations with the last observed queue count, and settled upload outcomes for live submissions and outbox drains. Snapshots contain only fixed codes and counters, perform no storage or network work, and reset when the SDK starts or is killed. With an older native SDK the React Native getter returns `unsupported/native-method-missing`, and the browser export returns `unsupported/platform`.

### Patch Changes

- 66ba27b: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android session replays now keep recording on screens with text fields, video players and sensitive views. Those areas are painted black in the replay instead of the whole frame being dropped, so a replay no longer freezes on the last safe screen. Because such screens are now recorded apart from the masked areas, mark any secret that is also shown outside an input, such as one-time-code digit cells or a card preview. A frame is still skipped when the SDK cannot prove where a sensitive view is drawn: during legacy view animations, layout transitions, shared-element transitions and container transforms (unless the app removed the container holding the sensitive view instead of hiding it); while a sensitive view or one of its containers is `INVISIBLE`, or fully transparent even when also `GONE` (as one-time-code inputs styled with `opacity: 0` are, and as a container faded to alpha 0 and then set `GONE` stays until its alpha is restored); while React Native content inside `<EverframeSensitive>` is hidden with `display: 'none'`; while the keyboard pans the window; and while a masked area moves on screen. A view inside another sensitive view is checked only as part of that view unless the SDK tracks it, as it does every view marked with `Everframe.markSensitive`. Its own transparency then skips no frames, and while a transition (a shared-element ghost, for example) or a container transform draws it elsewhere, `GONE` or not, frames can be recorded with only the outer mask, so mark such a container itself with `Everframe.markSensitive` (as `TXSensitiveView` and `<EverframeSensitive>` do); a bare `R.id.tx_sensitive` tag on a view inside another sensitive view is ignored. Compose and Flutter windows remain excluded, also in minified release builds, including ones that take Everframe's keep rules from its Gradle plugin. Frames are also no longer dropped just because the app redraws while a frame is being copied (focus moves, spinners), which left Android TV replays almost static.

- 847221a: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Destroying the activity that shows the reporter on Android now closes the reporter and resolves the pending open as cancelled with reason `activity_destroyed`. The report's frozen replay capture is released and the reporter can open again. Previously the open could stay pending, the reporter stayed marked as presenting, and shake-to-report could stay disabled until the app restarted. Backgrounding the app does not close the reporter, and a report that was already sent is not affected. Cancelling the coroutine that opened the reporter after Send no longer strips the session replay, breadcrumbs and network bodies from the report being submitted. The reporter also stays marked as presenting until that report finishes submitting, as it already did for a caller that keeps waiting, so shake-to-report stays disabled during that upload.

- 180b31d: <!-- SPDX-License-Identifier: MIT -->
    <!-- SPDX-FileCopyrightText: 2026 ScriptX -->
  Opening the reporter while one is already open no longer presents a second reporter on Android. A caller that opens it while the reporter is on screen now waits for that report and receives its result. After Send, while the report is still uploading, a new open resolves at once as cancelled with reason `already_presenting`. Either way, that caller's own pending `setExtra` value is discarded instead of shipping with a later, unrelated report. If the activity showing the reporter finishes or is destroyed before Send, the next open presents a new reporter instead of waiting, and callers already waiting resolve as cancelled with reason `activity_destroyed`. Previously a host shake listener firing together with the SDK's own shake trigger opened two reporters: the one on top had an empty capture, so the submitted report lost its session replay, and the hidden one kept replay recording paused until it was closed.
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/sdk-android

## 1.2.1

### Patch Changes

- afb0687: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Fix regressions from the Everframe rename. The Android SDK (and React Native on Android) now sends the `X-Everframe-*` header names the API reads, so native video session replay, verified identity and companion report attribution work again. In development under React StrictMode, `EverframeProvider` no longer keeps running with a killed client after the double mount, so two-way replies reach the reporter again.
