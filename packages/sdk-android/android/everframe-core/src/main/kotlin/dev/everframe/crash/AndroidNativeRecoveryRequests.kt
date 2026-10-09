// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

/** Command generations fence queued work; explicit disable also owns durable erasure.
 * Ordinary start and mode changes alter the command without discarding the preceding process's journal.
 */
internal class AndroidNativeRecoveryRequests {
    private var epoch = -1
    private var enabled = false
    private var diagnostics = false
    private var revision = 0L
    private val revocation = AndroidNativeRecoveryRevocation()

    /** An unsupported mode (native-only on API30) acts as a disable only when it narrows active diagnostics. */
    @Synchronized fun request(epoch: Int, enabled: Boolean, diagnostics: Boolean = false, supported: Boolean = true): Long {
        val narrowsDiagnostics = !diagnostics && epoch == this.epoch && this.enabled && this.diagnostics
        val effective = enabled && (supported || !narrowsDiagnostics)
        return transition(epoch, effective, !effective, diagnostics)
    }
    @Synchronized fun boundary(epoch: Int): Long = transition(epoch, false, false)
    private fun transition(epoch: Int, enabled: Boolean, erase: Boolean, diagnostics: Boolean = false): Long {
        if (epoch < this.epoch) return -1
        // Publish erasure before a newer true command can escape this monitor.
        // invalidate is atomic-only; no disk or revocation-monitor acquisition.
        if (erase) revocation.invalidate()
        if (epoch != this.epoch || enabled != this.enabled || (enabled && diagnostics) != this.diagnostics) revision++
        this.epoch = epoch
        this.enabled = enabled
        this.diagnostics = enabled && diagnostics
        return revision
    }
    fun invalidate() { revocation.invalidate() }
    fun finishRevocation(erase: () -> Boolean): Boolean = revocation.finish(erase)
    @Synchronized fun allows(revision: Long, epoch: Int, enabled: Boolean) =
        revision >= 0 && this.revision == revision && this.epoch == epoch && this.enabled == enabled
    @Synchronized fun diagnosticsEnabled(epoch: Int) = this.epoch == epoch && enabled && diagnostics
    @Synchronized fun enabled(epoch: Int) = this.epoch == epoch && enabled
}
