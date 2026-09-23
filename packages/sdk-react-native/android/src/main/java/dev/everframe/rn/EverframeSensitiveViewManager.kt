// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.rn

import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager
import dev.everframe.Everframe

/** Same props/Yoga node as View; sensitivity exists before native mount or JS onLayout. */
class EverframeSensitiveViewManager : ReactViewManager() {
    override fun getName(): String = "EverframeSensitiveView"
    public override fun createViewInstance(context: ThemedReactContext): ReactViewGroup =
        EverframeSensitiveView(context)
}

class EverframeSensitiveView(context: ThemedReactContext) : ReactViewGroup(context) {
    init { Everframe.markSensitive(this) }
}
