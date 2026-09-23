// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SampleApp — dogfoods every public Everframe API on iPhone and iPad.
// One @main entry point. Universal device family. iOS 16 deployment floor.

import SwiftUI
import EverframeKit
import EverframeReporterUI

@main
struct SampleApp: App {
    init() {
        // Wire the reporter resolver (open() + isPresenting state).
        // Phase 05.1: this no longer installs any gesture/key triggers — hosts
        // own that. installResolver() wires:
        //   • ReportAPI.__resolver       → so report.open() resolves through the presenter
        //   • ReportAPI.__setPresenting  → so report.isPresenting flips around present/dismiss
        // Hosts call this once alongside Everframe.shared.start(...).
        EFReporterPresenter.installResolver()

        // Read INGEST_SDK_KEY from Info.plist user-defined keys.
        // Pipeline: repo-root .env → scripts/gen-local-xcconfig.sh (preBuildScript)
        // → Config/Local.xcconfig → Config/Base.xcconfig → $(INGEST_SDK_KEY)
        // → Info.plist → Bundle.main here.
        //
        // Ingest URL is no longer plumbed through the sample — the Everframe SDK bakes it
        // at compile time (Release: https://everframe.dev; Debug: optional
        // EVERFRAME_DEV_INGEST_URL env var set via Xcode scheme).
        let sdkKey = (Bundle.main.object(forInfoDictionaryKey: "INGEST_SDK_KEY") as? String) ?? ""

        do {
            let config = EverframeConfig(
                appId: sdkKey,
                environment: .development,
                release: "1.0.0"
            )
            try Everframe.shared.start(config: config)
            // Demonstrate setUser(_:) — locked public API surface.
            Everframe.shared.setUser(EFUser(id: "demo-user-1", email: "demo@example.com", displayName: "Demo User"))
            Everframe.shared.setMetadata(["build": "sample-app"])
        } catch EverframeConfigError.missingAppId {
            print("Everframe: INGEST_SDK_KEY missing or malformed (must be `txx_live_…` 41 chars). Check repo-root .env and re-run `pnpm gen-ios-config`.")
        } catch {
            // Everframe SDK is non-fatal (DEFE-02). The app continues to launch.
            print("Everframe init failed: \(error)")
        }

        // Install the floating-bubble overlay (sample-owned, NOT Everframe SDK code —
        // see BubbleOverlay.swift for the canonical iOS recipe). install()
        // is idempotent and self-retries until a foreground UIWindowScene
        // exists, so calling here in init() is safe even though the scene
        // hasn't attached yet.
        BubbleOverlay.install()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
