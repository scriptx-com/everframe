// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

@MainActor
public enum SensitiveRectRegistry {

    /// Walk the view tree under `window` and collect rectangles (in window coordinate points)
    /// for every sensitive view: EFSensitiveView subclass, everframe_isSensitive=true, or UITextField.isSecureTextEntry=true.
    /// On hitting a sensitive view, does NOT descend (whole subtree is sensitive — early return).
    public static func collectSensitiveRects(in window: UIWindow) -> [CGRect] {
        var rects: [CGRect] = []
        walk(window, window: window, into: &rects)
        return rects
    }

    /// Mark a view as sensitive. Used by `Everframe.shared.markSensitive(_:)` — the public passthrough
    /// is wired in 04-06 atomically alongside other start()/kill() integration to avoid Wave-3 file
    /// collisions on Everframe.swift.
    public static func mark(_ view: UIView) {
        view.everframe_isSensitive = true
    }

    /// Single source of truth for sensitive-view detection. Reused by both
    /// SensitiveRectRegistry.walk (rect collection for screenshot blackout)
    /// and VTreeProducer (replay masking). Per Phase 04.1 Finding 5.
    public static func isSensitive(_ view: UIView) -> Bool {
        return view is EFSensitiveView
            || view.everframe_isSensitive
            || ((view as? UITextField)?.isSecureTextEntry == true)
    }

    private static func walk(_ view: UIView, window: UIWindow, into rects: inout [CGRect]) {
        let isSensitive: Bool = SensitiveRectRegistry.isSensitive(view)
        if isSensitive {
            // The window itself is its own root — convert(_:to:) on the window returns the same rect.
            let rectInWindow = view.convert(view.bounds, to: window)
            rects.append(rectInWindow)
            return
        }
        for sub in view.subviews { walk(sub, window: window, into: &rects) }
    }
}
#endif
