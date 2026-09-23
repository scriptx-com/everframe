// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import ObjectiveC.runtime

private var sensitiveKey: UInt8 = 0

public extension UIView {
    /// Marks this view as containing PII; the screenshot pipeline will black-box its rect at capture time
    /// and the UI tree will redact its props/children. Idempotent. Persists for the view's lifetime.
    var everframe_isSensitive: Bool {
        get { (objc_getAssociatedObject(self, &sensitiveKey) as? Bool) ?? false }
        set { objc_setAssociatedObject(self, &sensitiveKey, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC) }
    }
}
#endif
