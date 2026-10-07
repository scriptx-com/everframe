// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

/** Synchronous command generation fences work that has not reached the IO dispatcher yet. */
internal class AndroidNativeRecoveryRequests {
    private var epoch = -1
    private var enabled = false
    private var revision = 0L
    @Synchronized fun request(epoch: Int, enabled: Boolean): Long {
        if (epoch < this.epoch) return -1
        if (epoch != this.epoch || enabled != this.enabled) revision++
        this.epoch = epoch
        this.enabled = enabled
        return revision
    }
    @Synchronized fun allows(revision: Long, epoch: Int, enabled: Boolean) =
        revision >= 0 && this.revision == revision && this.epoch == epoch && this.enabled == enabled
    @Synchronized fun enabled(epoch: Int) = this.epoch == epoch && enabled
}
