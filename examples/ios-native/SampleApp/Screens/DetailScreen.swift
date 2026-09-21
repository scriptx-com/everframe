// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import SwiftUI
import TraceItXKit
import os

struct DetailScreen: View {
    let title: String
    @State private var fetchStatus = "(idle)"

    init(title: String = "Detail") {
        self.title = title
    }

    /// URLSession routed through TraceItX's opt-in URLProtocol so requests
    /// land in `NetworkRingBuffer.shared` and surface in the reporter's
    /// Network disclosure + envelope. The SDK explicitly does NOT swizzle
    /// URLSession globally (Pitfall 3), so hosts must opt in per session.
    private static let capturedSession: URLSession = {
        URLSession(configuration: TraceItX.shared.networkCaptureConfiguration())
    }()

    var body: some View {
        Form {
            Section("Network capture (NETWORK-01)") {
                Text("Last fetch: \(fetchStatus)")
                Button("GET https://example.com/") {
                    Task { await fetch() }
                }
            }
            Section("Log capture (LOG-01)") {
                Button("Emit os_log info") {
                    Logger(subsystem: "com.scriptx.traceitx.sample", category: "DetailScreen")
                        .info("user tapped emit-log")
                }
                Button("Emit os_log error") {
                    Logger(subsystem: "com.scriptx.traceitx.sample", category: "DetailScreen")
                        .error("simulated error from sample app")
                }
            }
        }
        .navigationTitle(title)
    }

    private func fetch() async {
        fetchStatus = "fetching..."
        do {
            let (_, resp) = try await Self.capturedSession.data(from: URL(string: "https://example.com/")!)
            if let http = resp as? HTTPURLResponse {
                fetchStatus = "HTTP \(http.statusCode)"
            } else {
                fetchStatus = "(non-http response)"
            }
        } catch {
            fetchStatus = "error: \(error.localizedDescription)"
        }
    }
}
