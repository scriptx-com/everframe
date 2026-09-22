// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Per-module-instance Session Vitals bridge (spec 2026-09-06; codex round-1, C4).
//
// WHY THIS EXISTS. The five vitals shims used to hang off `TraceItXBridge` as
// `static` funcs over a `private static let remotePlayers` registry — one map
// for the whole PROCESS. React Native does not guarantee one module instance:
// a host can run several React instances (a brownfield app embedding two
// surfaces, and RN's own reload path, which builds the new instance BEFORE it
// invalidates the old one). With a process-wide registry those instances share
// one token space, so instance B's `rp1` collides with instance A's still-live
// `rp1` (the second `trackPlayer` is silently refused, and that player's whole
// session goes unmeasured), and — worse — B's `invalidate` runs `detachAll()`
// over A's registrations, tearing down players A is still using.
//
// The Android module has never had this problem: its registry is a plain
// instance field on the module (`private val remotePlayers`), so each instance
// owns its own token space and its own teardown. This is the same shape.
//
// LIFETIME: one `RemoteVitalsBridge` per `TraceItXModule` instance, created at
// module init and released with it. `reset()` runs from `-[TraceItXModule
// invalidate]`, i.e. on module-instance teardown, which is exactly what a
// Metro/OTA reload does; it detaches ONLY this instance's players. That
// teardown is terminal — see `RemotePlayerRegistry.detachAll()` — because the
// reload constructs a NEW module instance with a NEW registry for the new
// bundle. A bare `TraceItX.shared` restart does NOT reach here: the module
// instance survives it, and the JS hooks still own detach for every player
// they registered.
//
// This class is GLUE — no validation lives here: unknown tokens, out-of-range
// timestamps and the 32-token cap are all the registry's business, and every
// one of its methods is a silent no-op rather than a throw.
import Foundation
import TraceItXKit

@objc public final class RemoteVitalsBridge: NSObject {

    /// `captureSourceQuery` is a PROVIDER closure resolved at attach time (I13), never a
    /// value read once at `configure()` — a host that reconfigures mid-session must get the
    /// new answer for players attached afterwards.
    private let remotePlayers = RemotePlayerRegistry(
        register: { integration, name in TraceItX.shared.trackPlayer(integration, name: name) },
        sessionTrack: { name, data in TraceItX.shared.trackVitals(name, data: data, player: nil) },
        captureSourceQuery: { TraceItX.shared.currentConfig?.vitals.captureSourceQuery ?? false })

    @objc public func trackPlayer(
        _ token: NSString,
        library: NSString,
        name: NSString?,
        libraryVersion: NSString?
    ) {
        remotePlayers.track(
            token: token as String,
            library: library as String,
            name: name as String?,
            libraryVersion: libraryVersion as String?
        )
    }

    @objc public func detachPlayer(_ token: NSString) {
        remotePlayers.detach(token: token as String)
    }

    @objc public func recordPlayerEvent(
        _ token: NSString,
        type: NSString,
        t: Double,
        data: NSDictionary?
    ) {
        remotePlayers.record(
            token: token as String,
            type: type as String,
            t: t,
            data: data as? [String: Any]
        )
    }

    @objc public func updatePlayerStats(_ token: NSString, stats: NSDictionary) {
        remotePlayers.updateStats(
            token: token as String,
            stats: (stats as? [String: Any]) ?? [:]
        )
    }

    @objc public func trackVitals(_ name: NSString, dataJson: NSString?, token: NSString?) {
        remotePlayers.trackVitals(
            name: name as String,
            dataJson: dataJson as String?,
            token: token as String?
        )
    }

    /// Detach every player registered through THIS module instance and close the registry.
    /// Called from `-[TraceItXModule invalidate]`. Idempotent.
    @objc public func reset() {
        remotePlayers.detachAll()
    }
}
