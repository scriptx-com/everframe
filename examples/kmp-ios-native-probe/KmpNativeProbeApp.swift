// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import SwiftUI
import EverframeKmp

@main
struct KmpNativeProbeApp: App {
    var body: some Scene {
        WindowGroup { KmpNativeProbeView() }
    }
}

struct KmpNativeProbeView: View {
    @State private var client = EverframeKmp(driver: EverframeSwiftDriver())
    @State private var started = false
    @State private var screen = "A"
    @State private var secret = "private sample text"
    @State private var reporterStatus = "idle"

    var body: some View {
        VStack(spacing: 20) {
            Text("SwiftUI screen \(screen)")
                .font(.title)
            SecureField("Sensitive", text: $secret)
                .textFieldStyle(.roundedBorder)
            Button("Start Everframe") {
                started = client.start(config: EverframeKmpConfig(
                    appId: "kmp-native-probe",
                    sdkKey: "txx_live_" + String(repeating: "0", count: 32),
                    environment: "development"))
                reporterStatus = started ? "started" : "start blocked"
            }
            Button("Next screen") {
                screen = screen == "A" ? "B" : "A"
                client.recordScreen(name: "SwiftUI-\(screen)")
                client.addBreadcrumb(message: "next screen", kind: "tap", level: nil)
            }
            .disabled(!started)
            Button("Open native reporter") {
                client.openReporter { outcome in
                    DispatchQueue.main.async { reporterStatus = outcome.status }
                }
            }
            .disabled(!started)
            Button("Kill") {
                client.kill()
                started = false
            }
            .disabled(!started)
            Text(reporterStatus)
        }
        .padding()
    }
}
