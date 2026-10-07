// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

/** Command generations fence queued work; explicit disable also owns durable erasure.
 * Ordinary start changes the command without discarding the preceding process's journal.
 */
internal class AndroidNativeRecoveryRequests {
    private var epoch = -1
    private var enabled = false
    private var revision = 0L
    private val revocation = AndroidNativeRecoveryRevocation()

    @Synchronized fun request(epoch: Int, enabled: Boolean): Long = transition(epoch, enabled, !enabled)
    @Synchronized fun boundary(epoch: Int): Long = transition(epoch, false, false)
    private fun transition(epoch: Int, enabled: Boolean, erase: Boolean): Long {
        if (epoch < this.epoch) return -1
        // Publish erasure before a newer true command can escape this monitor.
        // invalidate is atomic-only; no disk or revocation-monitor acquisition.
        if (erase) revocation.invalidate()
        if (epoch != this.epoch || enabled != this.enabled) revision++
        this.epoch = epoch
        this.enabled = enabled
        return revision
    }
    fun invalidate() { revocation.invalidate() }
    fun finishRevocation(erase: () -> Boolean): Boolean = revocation.finish(erase)
    @Synchronized fun allows(revision: Long, epoch: Int, enabled: Boolean) =
        revision >= 0 && this.revision == revision && this.epoch == epoch && this.enabled == enabled
    @Synchronized fun enabled(epoch: Int) = this.epoch == epoch && enabled
}
