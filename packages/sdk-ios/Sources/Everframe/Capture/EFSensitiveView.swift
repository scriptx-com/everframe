// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

/// Marker subclass for views that should be redacted in screenshots and UI tree captures.
/// Use as a wrapper around credit card fields, OTP inputs, custom secure controls.
/// For views you don't own, use `UIView.everframe_isSensitive = true` or `Everframe.shared.markSensitive(_:)`.
public final class EFSensitiveView: UIView {}
#endif
