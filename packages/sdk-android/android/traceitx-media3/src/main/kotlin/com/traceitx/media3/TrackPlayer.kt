// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public entry point of com.traceitx:media3 (spec 2026-09-05 §3).
package com.traceitx.media3

import android.os.Handler
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import com.traceitx.TraceItX
import com.traceitx.vitals.PlayerHandle
import com.traceitx.vitals.PlayerIntegration
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Attach an ExoPlayer to Session Vitals. One AnalyticsListener; detaches
 * itself when the player is released. Safe to call before vitals start —
 * the registration is honoured the moment the collector does.
 *
 * I8 — `@OptIn`, not `@UnstableApi`. Nothing in this function's SIGNATURE is
 * unstable (`ExoPlayer` and `Player.applicationLooper` are stable Media3
 * API; `PlayerHandle` is ours); only the internals it reaches for are. As
 * `@UnstableApi` this propagated the opt-in requirement onto every customer
 * call site, so the documented one-liner did not compile without an
 * annotation the docs never mentioned. `trackPlayerWith` and
 * `Media3Integration` stay marked — they genuinely expose unstable types.
 */
@androidx.annotation.OptIn(UnstableApi::class)
@JvmOverloads
fun TraceItX.trackPlayer(player: ExoPlayer, name: String? = null): PlayerHandle {
    val facade = ExoPlayerFacade(player)
    val looperHandler = Handler(player.applicationLooper)
    return trackPlayerWith(
        facade = facade,
        name = name,
        register = { integration, n -> TraceItX.trackPlayer(integration, n) },
        // I13 — a PROVIDER, not a value. `Media3Integration` resolves it when
        // it ATTACHES, which for a registration made before `start()` (or
        // between `kill()` and the next `start()`) is when the runtime drains
        // it into a controller. Read here, `currentConfig` is null in exactly
        // those cases and the option was permanently frozen off.
        captureSourceQuery = { TraceItX.currentConfig?.vitals?.captureSourceQuery ?: false },
        // Round-2, Important 10 — the result is the post's ACCEPTANCE.
        // `Handler.post` answers false once the looper is quitting (a released
        // player), and the integration turns that into a refused attach rather
        // than a registration nothing will ever unsubscribe or release.
        post = { r -> if (looperHandler.looper.isCurrentThread) { r.run(); true } else looperHandler.post(r) },
    )
}

@UnstableApi
internal fun trackPlayerWith(
    facade: Media3PlayerFacade,
    name: String?,
    register: (PlayerIntegration, String?) -> PlayerHandle,
    captureSourceQuery: () -> Boolean,
    post: (Runnable) -> Boolean,
): PlayerHandle {
    val integration = Media3Integration(facade, captureSourceQuery, post, System::currentTimeMillis)
    // M3 — the release hook is armed BEFORE `register`, not after. `register`
    // runs `integration.attach()`, which subscribes the AnalyticsListener; a
    // player released inside that window used to find `onReleased == null`
    // and the detach was dropped, leaving a live registration for a dead
    // player. The handle does not exist yet at that point, so it is reached
    // through a holder, and `released` replays the detach for the case where
    // the release lands before the holder is filled. `PlayerHandle.detach()`
    // is idempotent (the registry unregister returns null the second time),
    // so the replay cannot double-emit `player_detach`.
    val holder = AtomicReference<PlayerHandle?>(null)
    val released = AtomicBoolean(false)
    integration.onReleased = {
        released.set(true)
        holder.get()?.detach()
    }
    // Codex round-8, #1 — the declaration-time release observer is installed
    // and removed BY THE INTEGRATION (`Media3Integration.observeRelease`),
    // before `register` runs.
    //
    // Round 7 installed it here and took it off in a `PlayerHandle` this
    // function wrapped around `register`'s, which only the CALLER's `detach()`
    // ever reaches. Every controller-driven teardown — `kill()`, a superseding
    // `start()`, a revoked or cancelled pending registration — goes straight
    // to `PlayerIntegration.detach()` and bypassed that wrapper, so on a
    // long-lived ExoPlayer each start/track/kill cycle left one more observer
    // retaining `holder -> handle -> delegate -> dead controller`. The
    // observer's lifetime is the integration's, and `detach()` is the one
    // thing every teardown path has in common. The wrapper is gone with it:
    // `register`'s handle is returned directly.
    integration.observeRelease()

    val handle = register(integration, name)
    holder.set(handle)
    if (released.get()) handle.detach()
    return handle
}
