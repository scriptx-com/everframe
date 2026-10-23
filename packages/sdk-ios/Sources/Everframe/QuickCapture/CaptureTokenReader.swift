// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Reads the developer capture token from the host Mac via the simulator's
/// `SIMULATOR_HOST_HOME`. Read fresh at every capture; never cached or logged.
///
/// The CLI records the origin that issued the token as the credentials' `url`.
/// When it is present the token is returned only for an ingest endpoint with
/// that same origin; without it the token is returned as before.
enum CaptureTokenReader {
    static func read(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default,
        ingestEndpoint: URL
    ) -> String? {
        guard let home = environment["SIMULATOR_HOST_HOME"], !home.isEmpty else { return nil }
        let path = (home as NSString).appendingPathComponent(".everframe/credentials")
        guard let data = fileManager.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String else { return nil }
        if let issuer = json["url"] {
            guard let issuer = issuer as? String, sameOrigin(issuer, ingestEndpoint.absoluteString) else { return nil }
        }
        return validate(token)
    }

    /// Scheme, host (case-insensitive) and port, with default ports filled in.
    /// An unparseable URL never matches.
    static func sameOrigin(_ a: String, _ b: String) -> Bool {
        guard let left = origin(a) else { return false }
        return left == origin(b)
    }

    private struct Origin: Equatable {
        let scheme: String
        let host: String
        let port: Int
    }

    private static func origin(_ raw: String) -> Origin? {
        guard let components = URLComponents(string: raw.trimmingCharacters(in: .whitespaces)),
              let scheme = components.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = components.host?.lowercased(), !host.isEmpty else { return nil }
        return Origin(scheme: scheme, host: host, port: components.port ?? (scheme == "https" ? 443 : 80))
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
