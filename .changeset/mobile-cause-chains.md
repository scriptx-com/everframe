---
"@everframe/react-native": patch
"@everframe/web": patch
"@everframe/sdk-android": patch
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Mobile crash reports now include the error's cause chain. React Native sends `Error.cause` chains through the existing native bridge, including the stacks Hermes exposes on `Error.prototype`. Android captures `Throwable` causes next to the existing JVM metadata, and iOS follows the `NSUnderlyingErrorKey` of `NSError` and `CustomNSError` errors. Each chain keeps at most 8 causes, 32 frames per cause and 65,536 serialized UTF-8 bytes, is redacted before it is stored, and marks anything it drops as truncated. Malformed cause data never discards the outer report, and causes do not change how errors are grouped.

Cause redaction scans a bounded prefix of each field (8,192 characters) and of each JavaScript stack (32,768 characters). When either limit cuts the text, the cut token and any digit group before it are dropped before redaction, so a JWT, bearer token, card number or SSN split at the limit does not reach a report. The same holds for an email address when the web SDK's `redaction.maskInputs` includes `'email'`. This applies to web cause chains as well. Custom `redaction.customRules` patterns are matched only against the retained text, so when the limit cuts a custom match that contains spaces or other punctuation, the start of that match can remain unredacted.
