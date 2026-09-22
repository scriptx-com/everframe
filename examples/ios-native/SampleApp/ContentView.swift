// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 05.1: trigger detection is a host-app concern. This sample shows the
// canonical phone/tablet recipe — a Button that calls
// TraceItX.shared.report.open() and disables itself while the reporter is
// presenting (observed via the new @Published `report.isPresenting` surface).

import SwiftUI
import TraceItXKit

struct ContentView: View {
    /// Observe the reporter's presenting state so the trigger button can
    /// disable itself while the reporter is up. ReportAPI is an
    /// ObservableObject; its `isPresenting` is `@Published`.
    @ObservedObject private var report = TraceItX.shared.report

    var body: some View {
        NavigationStack {
            List {
                Section("Read") {
                    NavigationLink("List", destination: ListScreen())
                    NavigationLink("Detail", destination: DetailScreen())
                }
                Section("Sensitive content (PRIV-01..03)") {
                    NavigationLink("Login (TXSensitiveView + SecureField)", destination: LoginScreen())
                    NavigationLink("Payment (markSensitive)", destination: PaymentScreen())
                }
                Section("Session Vitals") {
                    NavigationLink("Playback (trackPlayer)", destination: PlaybackScreen())
                }
                Section("Error reporting") {
                    Button("Report handled error") {
                        do {
                            throw NSError(
                                domain: "TraceItXSample",
                                code: 1,
                                userInfo: [
                                    NSLocalizedDescriptionKey: "Native iOS handled error test"
                                ]
                            )
                        } catch {
                            TraceItX.shared.captureException(
                                error,
                                options: CaptureExceptionOptions(
                                    severity: .warning,
                                    context: "sample.error-reporting",
                                    metadata: [
                                        "screen": "root",
                                        "attempt": 1,
                                        "connectivity": ["online": true, "transport": "synthetic"],
                                    ]
                                )
                            )
                        }
                    }
                }
                Section("Trigger reporter") {
                    Button("Open TraceItX reporter") {
                        Task { try? await TraceItX.shared.report.open() }
                    }
                    .disabled(report.isPresenting)
                }
            }
            .navigationTitle("TraceItX Sample")
        }
    }
}

#Preview {
    ContentView()
}
