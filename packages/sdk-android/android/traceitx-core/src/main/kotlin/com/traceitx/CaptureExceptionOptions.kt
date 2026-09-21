// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx

enum class ErrorSeverity {
    INFO,
    WARNING,
    ERROR,
}

data class CaptureExceptionOptions @JvmOverloads constructor(
    val severity: ErrorSeverity = ErrorSeverity.ERROR,
    val context: String? = null,
    val metadata: Map<String, Any?>? = null,
)
