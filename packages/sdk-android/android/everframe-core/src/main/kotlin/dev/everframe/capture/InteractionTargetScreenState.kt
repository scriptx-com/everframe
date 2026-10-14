// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

internal object InteractionTargetScreenState {
    private var explicit: String? = null
    private var native: String? = null
    @Synchronized fun recordExplicit(name: String) { explicit = targetText(name) }
    @Synchronized fun recordNative(name: String) { native = targetText(name) }
    @Synchronized fun current(): String? = explicit ?: native
    @Synchronized fun reset() { explicit = null; native = null }
}
