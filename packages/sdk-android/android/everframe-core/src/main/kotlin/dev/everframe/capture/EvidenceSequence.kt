// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture
import java.util.concurrent.atomic.AtomicLong
internal class EvidenceSequence {
    private val value = AtomicLong()
    fun next(): Long = value.getAndIncrement()
    companion object { val shared = EvidenceSequence() }
}
