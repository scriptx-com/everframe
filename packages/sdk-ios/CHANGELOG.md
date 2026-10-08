# @everframe/sdk-ios-marker

## 0.1.0

### Minor Changes

- a5e45fd: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Mobile crash reports now include the error's cause chain. React Native sends `Error.cause` chains through the existing native bridge, including the stacks Hermes exposes on `Error.prototype`. Android captures `Throwable` causes next to the existing JVM metadata, and iOS follows the `NSUnderlyingErrorKey` of `NSError` and `CustomNSError` errors. Each chain keeps at most 8 causes, 32 frames per cause and 65,536 serialized UTF-8 bytes, is redacted before it is stored, and marks anything it drops as truncated. Malformed cause data never discards the outer report, and causes do not change how errors are grouped.

  Cause redaction scans a bounded prefix of each field (8,192 characters) and of each JavaScript stack (32,768 characters). When either limit cuts the text, the cut token and any digit group before it are dropped before redaction, so a JWT, bearer token, card number or SSN split at the limit does not reach a report. The same holds for an email address when the web SDK's `redaction.maskInputs` includes `'email'`. This applies to web cause chains as well. Custom `redaction.customRules` patterns are matched only against the retained text, so when the limit cuts a custom match that contains spaces or other punctuation, the start of that match can remain unredacted.

### Patch Changes

- bab392e: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Keep up to 60 seconds of session replay on iOS and tvOS, matching Android and the dashboard's replay duration setting. The recorder, session and exporter each capped the window at 30 seconds regardless of the configured duration.

  Player controls drawn over a video now stay visible in iOS and tvOS replays. The video surface is still recorded as a black box; before, its whole area was blacked out after rendering, which on a full-screen player blacked out the entire frame.

- 7e6e74e: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Fix a tvOS crash on the first remote press in apps that use scene-based focus. The press breadcrumb read `UIScreen.focusedView`, which UIKit refuses with "screen-based focus unsupported"; it now reads the focused view from the window's focus system.
