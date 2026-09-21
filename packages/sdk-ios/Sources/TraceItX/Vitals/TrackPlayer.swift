// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public entry point for AVPlayer (iOS spec 2026-09-05 §3). Twin of Android's
// TrackPlayer.kt: the release hook is armed BEFORE `register` (a player released
// inside attach's window must still detach), the declaration-time release
// sentinel is installed by the integration (so every teardown path releases
// it), and `captureSourceQuery` is a PROVIDER resolved at attach time.
import AVFoundation
import Foundation

public extension TraceItX {
    /// Attach an AVPlayer to Session Vitals. Holds the player WEAKLY; when it deallocates
    /// the registration detaches itself (`player_detach`). Calling `handle.detach()`
    /// before releasing the player is still the recommended path. Safe to call before
    /// vitals start — the registration is honoured the moment the collector does.
    func trackPlayer(_ player: AVPlayer, name: String? = nil) -> PlayerHandle {
        trackPlayerWith(facade: AVPlayerFacade(player: player), name: name,
                        register: { integration, n in TraceItX.shared.trackPlayer(integration, name: n) },
                        // A PROVIDER, not a value (Android I13): the integration resolves it when it
                        // ATTACHES, which for a registration made before `start()` — or between
                        // `kill()` and the next one — is when the runtime drains it into a controller.
                        // Read here, `currentConfig` is nil in exactly those cases and the option
                        // would be frozen off for the life of the registration.
                        captureSourceQuery: { TraceItX.shared.currentConfig?.vitals.captureSourceQuery ?? false })
    }
}

/// The seam the tests drive: everything `trackPlayer(_:name:)` does apart from building the
/// real facade and reaching for the live runtime.
func trackPlayerWith(facade: PlayerFacade, name: String?, register: (PlayerIntegration, String?) -> PlayerHandle,
                     captureSourceQuery: @escaping () -> Bool) -> PlayerHandle {
    let integration = AVPlayerIntegration(facade: facade, captureSourceQuery: captureSourceQuery)
    // Android M3 — the release hook is armed BEFORE `register`, not after. `register` runs
    // `integration.attach()`, which subscribes the facade; a player released inside that window
    // would otherwise find `onReleased == nil` and the detach would be dropped, leaving a live
    // registration for a dead player. The handle does not exist yet at that point, so it is
    // reached through a holder, and `released` replays the detach for the case where the release
    // lands before the holder is filled. `PlayerHandle.detach()` is idempotent, so the replay
    // cannot double-emit `player_detach`.
    let holder = Locked<PlayerHandle?>(nil)
    let released = Locked(false)
    integration.onReleased = {
        released.mutate { $0 = true }
        holder.value?.detach()
    }
    // Android round-8 #1 — the declaration-time release sentinel is installed AND removed by the
    // INTEGRATION, whose `detach()` is the one thing every teardown path has in common. Removing
    // it in a handle wrapper around `register`'s would only ever be reached by the caller's own
    // detach(), and every controller-driven teardown — kill(), a superseding start(), a revoked
    // or cancelled pending registration — goes straight to `PlayerIntegration.detach()`.
    integration.observeRelease()

    let handle = register(integration, name)
    holder.mutate { $0 = handle }
    if released.value { handle.detach() }
    return handle
}
