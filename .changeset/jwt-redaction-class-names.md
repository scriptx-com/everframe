---
"@everframe/protocol": patch
"@everframe/web": patch
"@everframe/sdk-android": patch
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

The built-in JWT redaction rule now matches only real tokens: a base64url JSON header starting with `eyJ` at the start of a word, followed by two more segments of at least 8 characters. Dotted class, package and module names, such as `dev.example.app.MainActivity`, `kotlinx.coroutines.internal` or `MyModule.CheckoutViewModel.submitOrder`, are no longer replaced with `[REDACTED:JWT]` in stack frames, messages, breadcrumbs and logs. The Android, iOS and JavaScript SDKs share the rule.
