// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ProcessLifecycleOwner bridge — same install idiom as LifecycleBreadcrumbObserver
// (addObserver must run on main). One instance per VitalsController.
package com.traceitx.vitals

import android.os.Handler
import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.traceitx.envelope.txGuardVoid
import java.util.concurrent.atomic.AtomicBoolean

internal class VitalsLifecycleObserver(
    private val onForeground: () -> Unit,
    private val onBackground: () -> Unit,
    /** Seam: the real ProcessLifecycleOwner in production, a TestLifecycleOwner under test. */
    private val owner: () -> LifecycleOwner = { ProcessLifecycleOwner.get() },
) : DefaultLifecycleObserver {
    /**
     * Flipped INSIDE the posted blocks, never at call time — it records what
     * the main queue has actually done, so a double install (or an uninstall
     * with no install) is a no-op rather than an unbalanced
     * add/removeObserver.
     */
    private val installed = AtomicBoolean(false)

    /**
     * Both [install] and [uninstall] ALWAYS post, even when the caller is
     * already on main. Final review, I3: the previous version ran inline when
     * it happened to be on the main thread, so an `install()` from a
     * background thread (a `start()` tail, or a server-config apply) queued a
     * runnable while a `uninstall()` racing it from main ran IMMEDIATELY —
     * the removeObserver executed first, the queued addObserver landed after
     * it, and the observer stayed registered on ProcessLifecycleOwner for the
     * rest of the process, feeding a dead controller. Unconditional posting
     * makes the main queue the single ordering authority: whatever order the
     * two calls were made in is the order they take effect in.
     */
    /**
     * Codex round-3, Important 10 — `addObserver` brings a new observer UP to
     * the owner's current state (it replays `ON_CREATE`/`ON_START`/`ON_RESUME`
     * as needed), but it never replays a `ON_STOP` that has already happened.
     * So enablement arriving while the process was in the background installed
     * an observer that heard nothing at all, and the sampler that the
     * controller's tail had just started kept sampling — and the collector
     * kept uploading — for the whole background interval, until the next
     * genuine foreground/background cycle.
     *
     * The current state is read HERE, on main, inside the same post as the
     * `addObserver` — so it cannot be read stale against a lifecycle event
     * dispatched between the two (lifecycle events are dispatched on main).
     * Anything below `STARTED` takes the background path immediately, which
     * pauses the sampler and flushes; the next real `onStart` resumes it.
     */
    fun install() = postToMain {
        if (installed.compareAndSet(false, true)) {
            val lifecycle = owner().lifecycle
            lifecycle.addObserver(this)
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                txGuardVoid("VitalsLifecycleObserver.installBackground") { onBackground() }
            }
        }
    }

    fun uninstall() = postToMain {
        if (installed.compareAndSet(true, false)) owner().lifecycle.removeObserver(this)
    }

    override fun onStart(owner: LifecycleOwner) = txGuardVoid("VitalsLifecycleObserver.onStart") { onForeground() }
    override fun onStop(owner: LifecycleOwner) = txGuardVoid("VitalsLifecycleObserver.onStop") { onBackground() }

    private fun postToMain(block: () -> Unit) {
        Handler(Looper.getMainLooper()).post { txGuardVoid("VitalsLifecycleObserver.post", block) }
    }
}
