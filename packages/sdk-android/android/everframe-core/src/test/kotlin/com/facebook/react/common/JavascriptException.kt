// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.facebook.react.common

// Mirrors RN's wrapper type without adding React Native to the native SDK tests.
class JavascriptException(message: String) : RuntimeException(message)
