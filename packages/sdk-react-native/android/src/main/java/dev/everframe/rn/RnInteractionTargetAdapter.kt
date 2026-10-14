// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.rn

import android.view.View
import com.facebook.react.uimanager.ReactAccessibilityDelegate.AccessibilityRole
import com.facebook.react.uimanager.ReactAccessibilityDelegate.Role
import dev.everframe.capture.InteractionTargetViewAdapter
import dev.everframe.capture.InteractionTargetViewHints
import java.util.Locale

internal object RnInteractionTargetAdapter : InteractionTargetViewAdapter {
    override fun describe(view: View): InteractionTargetViewHints? {
        val testId = view.getTag(com.facebook.react.R.id.react_test_id) as? String
        val rawRole = ((view.getTag(com.facebook.react.R.id.role) as? Role)?.name
            ?: (view.getTag(com.facebook.react.R.id.accessibility_role) as? AccessibilityRole)?.name)?.lowercase(Locale.ROOT)
        val role = when (rawRole) {
            "imagebutton" -> "button"
            "adjustable" -> "slider"
            "edittext", "search", "searchbox", "textbox" -> "textfield"
            "heading" -> "header"
            "img" -> "image"
            "none", null -> null
            else -> rawRole
        }
        return InteractionTargetViewHints(testId = testId, role = role,
            actionable = role in setOf("button", "tab", "link", "switch", "checkbox", "radio", "slider", "menuitem", "textfield"))
    }
}
