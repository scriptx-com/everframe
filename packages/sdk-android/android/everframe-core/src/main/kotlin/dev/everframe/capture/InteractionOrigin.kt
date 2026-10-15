// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.content.Context
import android.content.ContextWrapper
import android.view.View
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Attribution uses framework/native identity and bound annotations, never displayed text. */
internal object InteractionOrigin {
    fun resolve(view: View, target: View): JsonObject {
        var current: View? = view
        repeat(64) {
            val node = current ?: return@repeat
            val annotated = runCatching { InteractionTargetRegistry.lookup(node)?.get("devtoolsOrigin") == JsonPrimitive(true) }.getOrDefault(false)
            if (annotated || frameworkClass(node.javaClass) || frameworkContext(node.context) || InteractionTargetViewAdapters.describe(node)?.devtools == true) {
                return JsonObject(mapOf("origin" to JsonPrimitive("devtools")))
            }
            current = node.parent as? View
        }
        val trigger = runCatching { InteractionTargetRegistry.lookup(target)?.get("reporterTrigger") }.getOrNull()
        if (trigger != null) return JsonObject(mapOf("origin" to JsonPrimitive("reporter"), "trigger" to trigger))
        return JsonObject(emptyMap())
    }

    private fun frameworkClass(type: Class<*>?): Boolean {
        var current = type
        repeat(16) {
            val candidate = current ?: return false
            val name = candidate.name
            if (name.startsWith("com.facebook.react.devsupport.") || name.startsWith("expo.modules.devmenu.") ||
                name.startsWith("expo.modules.devlauncher.")) return true
            current = candidate.superclass
        }
        return false
    }

    private fun frameworkContext(context: Context): Boolean {
        var current = context
        repeat(16) {
            if (frameworkClass(current.javaClass)) return true
            val base = (current as? ContextWrapper)?.baseContext ?: return false
            if (base === current) return false
            current = base
        }
        return false
    }
}
