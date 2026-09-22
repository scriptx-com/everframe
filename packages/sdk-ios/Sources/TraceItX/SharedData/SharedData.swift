// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Loads packages/protocol/data/*.json (mirrored into Sources/TraceItX/Resources/
// at scaffold time and CI-gated for drift) into the SDK at first-access. Eager
// `static let` evaluation means each file is parsed exactly once per process
// lifetime, then cached. No locks needed — Swift `let`-static initialization is
// thread-safe at the language level.
//
// Per CONTEXT decision 4: shared data JSON is the cross-language source of
// truth. Each native SDK reimplements logic idiomatically but consumes the
// same JSON, so iOS / Android / web cannot drift on what counts as "sensitive".
import Foundation

// Resource bundle resolver. The published artifact is the xcframework
// (project.yml → scripts/build-xcframework.sh), where Bundle(for:) keyed
// off a private marker class resolves to the framework's own bundle. The
// SPM target is kept ONLY for the `swift test` dev workflow; there
// `Bundle.module` is the synthetic SPM accessor that points at the
// resource sub-bundle SPM builds alongside the module.
#if SWIFT_PACKAGE
private let traceitxResourceBundle: Bundle = .module
#else
private final class TraceItXResourceMarker {}
private let traceitxResourceBundle: Bundle = Bundle(for: TraceItXResourceMarker.self)
#endif

public struct RedactionPattern: Codable, Equatable, Sendable {
    public let id: String
    public let regex: String
    public let replacement: String?
    public let description: String?
}

public struct SensitiveHeaders: Codable, Sendable {
    public let version: Int
    public let sensitive_to_redact: [String]
    public let allowed_to_capture: [String]
}

public struct NetworkPathPatterns: Codable, Sendable {
    public let version: Int
    public let sensitive_paths: [SensitivePath]
    public struct SensitivePath: Codable, Sendable {
        public let id: String
        public let regex: String
        public let redact: String
        public let replacement: String?
    }
}

public enum SharedData {
    public static let redactionPatterns: [RedactionPattern] = {
        guard let url = traceitxResourceBundle.url(forResource: "redaction-patterns", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return [] }
        struct Wrapper: Codable { let patterns: [RedactionPattern] }
        return (try? JSONDecoder().decode(Wrapper.self, from: data).patterns) ?? []
    }()

    public static let sensitiveHeadersToRedact: Set<String> = {
        guard let url = traceitxResourceBundle.url(forResource: "sensitive-headers", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(SensitiveHeaders.self, from: data) else { return [] }
        return Set(decoded.sensitive_to_redact.map { $0.lowercased() })
    }()

    public static let allowedHeadersToCapture: Set<String> = {
        guard let url = traceitxResourceBundle.url(forResource: "sensitive-headers", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(SensitiveHeaders.self, from: data) else { return [] }
        return Set(decoded.allowed_to_capture.map { $0.lowercased() })
    }()

    public static let networkPathPatterns: NetworkPathPatterns? = {
        guard let url = traceitxResourceBundle.url(forResource: "network-path-patterns", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(NetworkPathPatterns.self, from: data)
    }()
}
