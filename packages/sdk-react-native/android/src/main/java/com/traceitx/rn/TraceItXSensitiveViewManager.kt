// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.rn

import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.react.views.view.ReactViewManager
import com.traceitx.TraceItX

/** Same props/Yoga node as View; sensitivity exists before native mount or JS onLayout. */
class TraceItXSensitiveViewManager : ReactViewManager() {
    override fun getName(): String = "TraceItXSensitiveView"
    public override fun createViewInstance(context: ThemedReactContext): ReactViewGroup =
        TraceItXSensitiveView(context)
}

class TraceItXSensitiveView(context: ThemedReactContext) : ReactViewGroup(context) {
    init { TraceItX.markSensitive(this) }
}
