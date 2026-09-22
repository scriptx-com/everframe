// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A STAND-IN for react-native-svg's `com.horcrux.svg.SvgView`, living at that
// exact fully-qualified name so the composite-painter allowlist can be tested
// without taking a dependency on react-native-svg (an RN Android artifact this
// module has no business pulling into a JVM unit test).
//
// It mirrors the two properties the allowlist exists for: it is a ViewGroup, so
// the structural leaf rule cannot see it, and it paints its children itself in
// `onDraw` while they paint nothing — which is why walking into them produces
// nodes that describe nothing.
//
// Test sources only. If this ever appears on a runtime classpath, something is
// very wrong.
package com.horcrux.svg

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import android.view.ViewGroup

open class SvgView(context: Context) : ViewGroup(context) {

    private val paint = Paint().apply { color = Color.rgb(46, 64, 52) }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        for (i in 0 until childCount) getChildAt(i).layout(0, 0, r - l, b - t)
    }

    override fun onDraw(canvas: Canvas) {
        canvas.drawCircle(width / 2f, height / 2f, minOf(width, height) / 2f, paint)
    }

    /** A child that exists to carry props and never paints — RNSVG's VirtualView. */
    class VirtualView(context: Context) : View(context)
}
