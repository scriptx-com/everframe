// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SampleAppTV — exercises the SDK on Apple TV.
//
// Reporting on tvOS is COMPANION-ONLY: the on-device modal reporter was
// removed (Phase 06.2 follow-up). To file a report from this app, navigate
// to the "Companion QR" screen, scan the QR code with a phone, and use the
// phone-side reporter SPA. The TV-side companion plumbing lives in
// TraceItX's core (RelayWSClient + CompanionCaptureBridge); no separate
// `TraceItXReporterUI` import is needed here.

import SwiftUI
import TraceItXKit

@main
struct SampleAppTV: App {
    init() {
        // Read INGEST_SDK_KEY from Info.plist user-defined keys. Pipeline
        // mirrors SampleApp.swift. Ingest URL is no longer plumbed through;
        // the SDK bakes it at compile time (see IngestEndpoint.swift).
        let sdkKey = (Bundle.main.object(forInfoDictionaryKey: "INGEST_SDK_KEY") as? String) ?? ""

        do {
            let config = TraceItXConfig(
                appId: sdkKey,
                environment: .development,
                release: "1.0.0"
            )
            try TraceItX.shared.start(config: config)
            TraceItX.shared.setUser(TXUser(id: "demo-tv-user", displayName: "Apple TV Demo"))
        } catch TraceItXConfigError.missingAppId {
            print("TraceItX: INGEST_SDK_KEY missing or malformed (must be `txx_live_…` 41 chars). Check repo-root .env and re-run `pnpm gen-ios-config`.")
        } catch {
            print("TraceItX init failed: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
