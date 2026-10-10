---
"@everframe/protocol": patch
"@everframe/web": patch
"@everframe/sdk-android": patch
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

The built-in JWT redaction rule now matches only real tokens and is applied in linear time. A token starts with a base64url JSON header (`eyJ`) at the start of a word, may have an empty second segment (a `dir` or ECDH-ES JWE) and has up to five segments; a token glued to the text before it (`%3DeyJ…`, `Bearer%20eyJ…`, `x_eyJ…`, `\neyJ…` in JSON) is caught when its payload also starts with `eyJ`. Dotted class, package and module names, such as `dev.example.app.MainActivity`, `kotlinx.coroutines.internal` or `MyModule.CheckoutViewModel.submitOrder`, are no longer replaced with `[REDACTED:JWT]` in stack frames, messages, breadcrumbs and logs. The Android, iOS and JavaScript SDKs share the rule (`JWT_PATTERN` and `redactJwt` in `@everframe/protocol`). Each SDK applies it with a linear scan, so a hostile body such as `eyJ-eyJ-…` no longer costs seconds of CPU.
