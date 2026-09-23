// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public View-side sensitive marker. Subclass this FrameLayout (or wrap your
// sensitive content inside one) to mask the entire subtree from screenshot
// capture and emit the subtree as a sensitive leaf in the UI tree.
//
// Mirrors `packages/sdk-ios/Sources/Everframe/Sensitive/TXSensitiveView.swift`
// (UIView equivalent). On Android we use FrameLayout because customers most
// often need to wrap an existing layout subtree without imposing a layout
// behavior — FrameLayout is the cheapest no-op container.
//
// Open by design: customers may subclass for layout extension. Detection is
// `is TXSensitiveView`, so subclasses are still detected.

package dev.everframe.sensitive

import android.content.Context
import android.util.AttributeSet
import android.widget.FrameLayout

public open class TXSensitiveView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : FrameLayout(context, attrs, defStyleAttr) {
    init {
        // Belt-and-suspenders: tag the view too. Some hosts may receive a
        // TXSensitiveView via a generic View reference where `is` checks
        // happen elsewhere; the tag is the universal fallback.
        dev.everframe.Everframe.markSensitive(this)
    }
}
