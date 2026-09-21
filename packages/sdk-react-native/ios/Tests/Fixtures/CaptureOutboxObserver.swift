// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import TraceItXKit

// Copy into an owned generated Debug host target and call start() at launch.
// Reads the real encrypted outbox in the app/keychain context; never enqueues,
// drains, builds an envelope or changes the SDK's capture configuration.
enum CaptureOutboxObserver {
    static func start() -> Task<Void, Never> {
        Task {
            let expected: Set<String> = ["c1a-installed-top-level", "c1a-installed-hook"]
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let output = directory.appendingPathComponent("c1a-capture-outbox.json")
            do {
                for _ in 0..<120 {
                    try Task.checkCancellation()
                    let entries = try JSONLOutbox().hydrate().filter { entry in
                        guard let envelope = try? JSONSerialization.jsonObject(with: entry.envelopeBytes) as? [String: Any],
                              let payload = envelope["payload"] as? [String: Any],
                              let crash = payload["crash"] as? [String: Any],
                              let message = crash["message"] as? String else { return false }
                        return expected.contains(message)
                    }
                    // Export original persisted entries, including base64
                    // envelopeBytes and captured endpoint, for external checks.
                    try JSONEncoder().encode(entries).write(to: output, options: .atomic)
                    let messages = Set(entries.compactMap { entry -> String? in
                        guard let envelope = try? JSONSerialization.jsonObject(with: entry.envelopeBytes) as? [String: Any],
                              let payload = envelope["payload"] as? [String: Any],
                              let crash = payload["crash"] as? [String: Any] else { return nil }
                        return crash["message"] as? String
                    })
                    if messages == expected { return }
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                try Data("timed out waiting for both persisted probes".utf8).write(
                    to: directory.appendingPathComponent("c1a-capture-observer-error.txt"))
            } catch {
                try? Data(String(describing: error).utf8).write(
                    to: directory.appendingPathComponent("c1a-capture-observer-error.txt"))
            }
        }
    }
}
