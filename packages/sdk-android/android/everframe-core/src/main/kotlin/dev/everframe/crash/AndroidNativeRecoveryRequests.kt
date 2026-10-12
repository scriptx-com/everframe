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

    /** An explicit false erases unadmitted evidence; a true command keeps it for the new owner's recovery. */
    @Synchronized fun request(epoch: Int, enabled: Boolean, diagnostics: Boolean = false): Long =
        transition(epoch, enabled, !enabled, diagnostics)
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
