// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Ingest URL. In Release builds the Swift compiler omits the `#if DEBUG`
// branch entirely — the published xcframework has no env-var lookup, no
// Info.plist lookup, and no "TRACEITX_DEV_INGEST_URL" string anywhere in
// its compiled bytecode. Debug builds (sample apps, xctest, local SPM)
// read two dev overrides so a developer can point a local sample at
// localhost / a LAN box without touching source:
//
//   1. `TRACEITX_DEV_INGEST_URL` process env — works when the process is
//      launched with a controlled environment (Xcode scheme env, xctest,
//      `simctl launch` with SIMCTL_CHILD_-prefixed host env).
//   2. `TraceItXDevIngestURL` in the HOST APP's Info.plist — needed because
//      not every launch path carries env: `expo run:ios` deep-links the app
//      via `simctl openurl` (SpringBoard spawns it, host env is dropped),
//      and home-screen relaunches never have it. The RN example's
//      `with-traceitx-ios-local` Expo plugin bakes this key at prebuild.
//
// Env wins over plist so a shell override can redirect a plist-baked build.
// The empty / blank guard means setting either to "" collapses to prod.
import Foundation

public enum IngestEndpoint {
    public static let url: URL = {
        #if DEBUG
        let raw = ProcessInfo.processInfo.environment["TRACEITX_DEV_INGEST_URL"]
            ?? (Bundle.main.object(forInfoDictionaryKey: "TraceItXDevIngestURL") as? String)
        if let raw,
           !raw.trimmingCharacters(in: .whitespaces).isEmpty,
           let dev = URL(string: raw) {
            return dev
        }
        #endif
        // swiftlint:disable:next force_unwrapping
        return URL(string: "https://traceitx.com")!
    }()
}
