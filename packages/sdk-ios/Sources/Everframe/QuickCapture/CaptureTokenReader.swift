// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Reads the developer capture token from the host Mac via the simulator's
/// `SIMULATOR_HOST_HOME`. Read fresh at every capture; never cached or logged.
enum CaptureTokenReader {
    static func read(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> String? {
        guard let home = environment["SIMULATOR_HOST_HOME"], !home.isEmpty else { return nil }
        let path = (home as NSString).appendingPathComponent(".everframe/credentials")
        guard let data = fileManager.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String else { return nil }
        return validate(token)
    }

    /// Trimmed value must be 1-512 printable ASCII characters (0x21-0x7E).
    static func validate(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else { return nil }
        let bytes = Array(trimmed.utf8)
        guard bytes.count <= 512, bytes.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E }) else { return nil }
        return trimmed
    }
}
