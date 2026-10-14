// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.*
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal data class InteractionTargetSnapshot(val label: String, val data: JsonObject)

/** All view access happens synchronously on the input/UI thread. */
internal object InteractionTargetResolver {
    private val actions = setOf("button", "link", "tab", "switch", "checkbox", "radio", "textfield", "slider")

    fun resolve(view: View): InteractionTargetSnapshot = try {
        if (sensitiveAncestry(view)) {
            masked(nativeRole(owner(view, useHints = false)))
        } else {
            val targetView = owner(view)
            // Promotion cannot escape the sensitivity of either lineage.
            if (sensitiveAncestry(targetView)) masked(nativeRole(targetView)) else describe(targetView)
        }
    } catch (_: Throwable) {
        // A failed privacy query cannot make a label safe to read.
        masked(null)
    }

    private fun masked(role: String?): InteractionTargetSnapshot {
        val target = linkedMapOf<String, Any?>("masked" to true)
        if (role != null) target["role"] = role
        return InteractionTargetSnapshot("[masked]", BreadcrumbRingBuffer.coerceHostData(mapOf("masked" to true, "target" to target)))
    }

    internal fun sensitiveAncestry(view: View): Boolean {
        var current: View? = view
        while (current != null) {
            if (SensitiveRectRegistry.isSensitive(current)) return true
            current = current.parent as? View
        }
        return false
    }

    private fun owner(view: View, useHints: Boolean = true): View {
        var current: View? = view
        var semantic: View? = null
        repeat(32) {
            val candidate = current ?: return semantic ?: view
            val hints = if (useHints) InteractionTargetViewAdapters.describe(candidate) else null
            val role = hints?.role ?: nativeRole(candidate)
            if (candidate.isClickable || hints?.actionable == true || role in actions) return candidate
            if (semantic == null && (role != null || (useHints && (hints?.testId != null || !candidate.contentDescription.isNullOrEmpty())))) semantic = candidate
            current = candidate.parent as? View
        }
        return semantic ?: view
    }

    private fun describe(view: View): InteractionTargetSnapshot {
        val hints = InteractionTargetViewAdapters.describe(view)
        val role = targetText(hints?.role, 64) ?: nativeRole(view)
        val id = targetText(hints?.testId) ?: resourceId(view)
        val accessibility = targetText(hints?.name) ?: targetText(view.contentDescription?.toString())
        val text = if (view is TextView && view !is EditText) targetText(view.text?.toString()) else null
        val descendant = if (accessibility == null && text == null) descendantText(view) else null
        val name = accessibility ?: text ?: descendant ?: id ?: targetText(view.javaClass.simpleName) ?: "view"
        val from = when { accessibility != null -> "accessibility"; text != null || descendant != null -> "text"; id != null -> "testId"; else -> "className" }
        val target = linkedMapOf<String, Any?>("name" to name, "nameFrom" to from)
        if (id != null) target["testId"] = id
        if (role != null) target["role"] = role
        container(view)?.let { target["container"] = it }
        InteractionTargetScreenState.current()?.let { target["screen"] = it }
        val data = linkedMapOf<String, Any?>("view" to view.javaClass.simpleName, "target" to target)
        if (id != null) data["id"] = id
        val automatic = BreadcrumbRingBuffer.coerceHostData(data)
        val annotation = InteractionTargetRegistry.lookup(view)
        if (annotation == null) return InteractionTargetSnapshot(targetText(name, 48) ?: "view", automatic)
        val mergedTarget = (automatic["target"] as JsonObject).toMutableMap()
        mergedTarget.putAll(annotation)
        if (annotation.containsKey("name")) mergedTarget["nameFrom"] = JsonPrimitive("annotation")
        // A stable-ID override must also update a name derived from that ID.
        if (annotation.containsKey("testId") && !annotation.containsKey("name") && from == "testId") mergedTarget["name"] = annotation.getValue("testId")
        val mergedData = automatic.toMutableMap()
        mergedData["target"] = JsonObject(mergedTarget)
        mergedTarget["testId"]?.let { mergedData["id"] = it }
        val mergedName = (mergedTarget["name"] as? JsonPrimitive)?.content ?: name
        return InteractionTargetSnapshot(targetText(mergedName, 48) ?: "view", JsonObject(mergedData))
    }

    private fun descendantText(view: View): String? {
        var visits = 0
        fun walk(node: View, depth: Int): String? {
            if (depth > 6 || visits >= 64) return null
            visits++
            if (node.visibility != View.VISIBLE || node.alpha <= 0 || SensitiveRectRegistry.isSensitive(node) || node is EditText) return null
            if (node is TextView) targetText(node.text?.toString())?.let { return it }
            if (node is ViewGroup) for (i in 0 until node.childCount) {
                if (visits >= 64) break
                walk(node.getChildAt(i), depth + 1)?.let { return it }
            }
            return null
        }
        if (view is ViewGroup) for (i in 0 until view.childCount) {
            if (visits >= 64) break
            walk(view.getChildAt(i), 1)?.let { return it }
        }
        return null
    }

    private fun container(view: View): Map<String, Any?>? {
        var current = view.parent as? View
        val item = nodeInfo(view)?.collectionItemInfo
        repeat(32) {
            val candidate = current ?: return null
            val hints = InteractionTargetViewAdapters.describe(candidate)
            val node = nodeInfo(candidate)
            val collection = node?.collectionInfo
            val role = hints?.role ?: nativeRole(candidate) ?: if (collection != null) "list" else null
            if (role in setOf("list", "grid", "tablist")) {
                val result = linkedMapOf<String, Any?>("role" to role)
                (targetText(hints?.testId) ?: resourceId(candidate))?.let { result["testId"] = it }
                targetText(candidate.contentDescription?.toString())?.let { result["name"] = it }
                // Linear collection positions only; no guessed grid flattening.
                if (collection != null) {
                    val count = when { collection.rowCount == 1 -> collection.columnCount; collection.columnCount == 1 -> collection.rowCount; else -> -1 }
                    if (count >= 0) {
                        result["count"] = count
                        val index = if (collection.rowCount == 1) item?.columnIndex else item?.rowIndex
                        if (index != null && index >= 0 && index < count) result["index"] = index
                    }
                }
                return result
            }
            current = candidate.parent as? View
        }
        return null
    }

    private fun nodeInfo(view: View): AccessibilityNodeInfo? = try { view.createAccessibilityNodeInfo() } catch (_: Throwable) { null }
    private fun resourceId(view: View): String? = if (view.id == View.NO_ID) null else try { targetText(view.resources.getResourceEntryName(view.id)) } catch (_: Throwable) { null }

    internal fun nativeRole(view: View): String? = when (view) {
        is EditText -> "textfield"
        is Switch, is ToggleButton -> "switch"
        is CheckBox -> "checkbox"
        is RadioButton -> "radio"
        is SeekBar -> "slider"
        is Button, is ImageButton -> "button"
        is AbsListView -> "list"
        else -> when {
            view.isClickable -> "button"
            view is ImageView -> "image"
            view is TextView -> "text"
            else -> null
        }
    }
}

/** Drop invalid UTF-16 and NUL; cap without splitting a supplementary character. */
internal fun targetText(value: String?, max: Int = 256): String? {
    if (value == null) return null
    val out = StringBuilder()
    var i = 0
    while (i < value.length && out.length < max) {
        val c = value[i++]
        if (c == '\u0000') continue
        if (c.isHighSurrogate()) {
            if (i < value.length && value[i].isLowSurrogate()) {
                if (out.length + 2 > max) break
                out.append(c).append(value[i++])
            }
        } else if (!c.isLowSurrogate()) out.append(c)
    }
    return out.toString().takeIf { it.isNotBlank() }
}
