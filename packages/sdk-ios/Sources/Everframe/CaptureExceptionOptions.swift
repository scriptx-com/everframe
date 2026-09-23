// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/// Severity of a deliberately captured native error.
public enum EverframeErrorSeverity: String, Sendable {
    case info, warning, error
}

/// Optional per-error details. Keep mutable metadata stable during synchronous
/// capture; the Everframe SDK owns the normalized copy when capture returns. Use NSNull
/// for JSON null. Arbitrary host references make these options non-Sendable.
public struct CaptureExceptionOptions {
    public let severity: EverframeErrorSeverity
    public let context: String?
    public let metadata: [String: Any]?

    public init(severity: EverframeErrorSeverity = .error, context: String? = nil,
                metadata: [String: Any]? = nil) {
        self.severity = severity
        self.context = context
        self.metadata = metadata
    }
}
