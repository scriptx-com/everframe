// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SampleAppTV — exercises the Everframe SDK on Apple TV.
//
// tvOS has no on-device reporter (the modal reporter was removed in a Phase
// 06.2 follow-up), so no `EverframeReporterUI` import is needed here.
// Crashes, errors and session replay are still captured.

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
                sdkKey: sdkKey,
                environment: .development,
                release: "1.0.0"
            )
            try Everframe.shared.start(config: config)
            Everframe.shared.setUser(EFUser(id: "demo-tv-user", displayName: "Apple TV Demo"))
        } catch EverframeConfigError.missingSdkKey {
            print("Everframe: INGEST_SDK_KEY missing or malformed (must be `evf_live_…` 41 chars; legacy `txx_live_…` also works). Check repo-root .env and re-run `pnpm gen-ios-config`.")
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
