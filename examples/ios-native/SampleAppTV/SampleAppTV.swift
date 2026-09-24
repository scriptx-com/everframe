// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SampleAppTV — exercises the Everframe SDK on Apple TV.
//
// Reporting on tvOS is COMPANION-ONLY: the on-device modal reporter was
// removed (Phase 06.2 follow-up). To file a report from this app, navigate
// to the "Companion QR" screen, scan the QR code with a phone, and use the
// phone-side reporter SPA. The TV-side companion plumbing lives in
// Everframe's core (RelayWSClient + CompanionCaptureBridge); no separate
// `EverframeReporterUI` import is needed here.

import SwiftUI
import EverframeKit

@main
struct SampleAppTV: App {
    init() {
        // Read INGEST_SDK_KEY from Info.plist user-defined keys. Pipeline
        // mirrors SampleApp.swift. Ingest URL is no longer plumbed through;
        // the Everframe SDK bakes it at compile time (see IngestEndpoint.swift).
        let sdkKey = (Bundle.main.object(forInfoDictionaryKey: "INGEST_SDK_KEY") as? String) ?? ""

        do {
            let config = EverframeConfig(
                appId: sdkKey,
                environment: .development,
                release: "1.0.0"
            )
            try Everframe.shared.start(config: config)
            Everframe.shared.setUser(EFUser(id: "demo-tv-user", displayName: "Apple TV Demo"))
        } catch EverframeConfigError.missingAppId {
            print("Everframe: INGEST_SDK_KEY missing or malformed (must be `txx_live_…` 41 chars). Check repo-root .env and re-run `pnpm gen-ios-config`.")
        } catch {
            print("Everframe init failed: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
