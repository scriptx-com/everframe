// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.os.SystemClock
import android.view.View
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsOwner
import androidx.compose.ui.semantics.SemanticsProperties
import dev.everframe.sensitive.TX_SENSITIVE_KEY
import java.io.InputStream
import java.lang.reflect.Method
import dev.everframe.capture.video.VideoPrivacyAdapter.Classification

/** Typed, unmerged semantics only. Production stays excluded until device budget validation. */
internal class ComposeVideoPrivacyAdapter(
    private val nowNanos: () -> Long = SystemClock::elapsedRealtimeNanos,
) {
    fun inspectForGate(host: View, deadlineNs: Long, remainingNodes: Int): Pair<Classification, Int> =
        inspectBudgeted(host, deadlineNs, remainingNodes).let { it.classification to it.visited }

    internal data class Inspection(val classification: Classification, val visited: Int)
    fun inspect(host: View, deadlineNs: Long, remainingNodes: Int): Classification =
        inspectBudgeted(host, deadlineNs, remainingNodes).classification

    internal fun inspectBudgeted(host: View, deadlineNs: Long, remainingNodes: Int): Inspection {
        var visited = 0
        fun excluded() = Inspection(Classification.EXCLUDE, visited)
        try {
            if (remainingNodes <= 0 || nowNanos() >= deadlineNs || runtimeVersion == null) return excluded()
            if (host.javaClass.name != HOST) return excluded()
            val method = accessor ?: return excluded()
            val owner = ownerFromAccessor(method, host) ?: return excluded()
            val queue = ArrayDeque<SemanticsNode>()
            queue.add(owner.unmergedRootSemanticsNode)
            while (queue.isNotEmpty()) {
                if (visited + queue.size > remainingNodes || nowNanos() >= deadlineNs) return excluded()
                val node = queue.removeFirst(); visited++
                if (sensitive(node.config)) return excluded()
                if (nowNanos() >= deadlineNs) return excluded()
                // Framework may walk nonsemantic layout nodes here. This call is not preemptible.
                val children = node.children
                if (nowNanos() >= deadlineNs || visited + queue.size + children.size > remainingNodes) return excluded()
                if (visited == 1 && children.isEmpty()) return excluded() // unready/empty owner
                queue.addAll(children)
            }
            return Inspection(Classification.ORDINARY_VIEW, visited)
        } catch (_: Throwable) { return excluded() }
    }

    companion object {
        private const val HOST = "androidx.compose.ui.platform.AndroidComposeView"
        private val accessor: Method? by lazy {
            try { Class.forName(HOST).getMethod("getSemanticsOwner").takeIf { it.returnType == SemanticsOwner::class.java } }
            catch (_: Throwable) { null }
        }
        private val runtimeVersion: String? by lazy {
            readVersion {
                val loader = ComposeVideoPrivacyAdapter::class.java.classLoader ?: return@readVersion null
                val resources = loader.getResources("META-INF/androidx.compose.ui_ui.version")
                if (!resources.hasMoreElements()) return@readVersion null
                val first = resources.nextElement()
                if (resources.hasMoreElements()) return@readVersion null
                first.openStream()
            }
        }
        internal fun ownerFromAccessor(method: Method?, host: Any): SemanticsOwner? = try {
            if (method?.returnType != SemanticsOwner::class.java) null else method.invoke(host) as? SemanticsOwner
        } catch (_: Throwable) { null }

        internal fun readVersion(open: () -> InputStream?): String? = try {
            open()?.use { input ->
                val bytes = ByteArray(32)
                var size = 0
                while (size < bytes.size) {
                    val count = input.read(bytes, size, bytes.size - size)
                    if (count < 0) break
                    if (count == 0) return@use null
                    size += count
                }
                if (size == 32) null else String(bytes, 0, size, Charsets.UTF_8).trim()
                    .takeIf { it == "1.7.5" || it == "1.9.4" }
            }
        } catch (_: Throwable) { null }

        internal fun sensitive(config: SemanticsConfiguration): Boolean =
            config.isClearingSemantics || config.contains(SemanticsProperties.Password) ||
                config.contains(SemanticsProperties.EditableText) || config.contains(SemanticsActions.SetText) ||
                config.getOrElse(TX_SENSITIVE_KEY) { false }
    }
}
