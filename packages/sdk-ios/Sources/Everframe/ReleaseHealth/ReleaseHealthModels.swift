// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

enum ReleaseHealthProcessIdentity { static let id = UUID() }
struct ReleaseHealthEntry: Codable, Equatable, Sendable {
    let recordID: UUID
    let createdAt: Date
    let sdkKey: String
    let endpoint: String
    let body: Data
}
enum ReleaseHealthDate {
    // Foundation's ISO decoder can land one floating-point step below an exact
    // millisecond. Nearest-millisecond normalization preserves its wire value.
    static func canonical(_ date: Date) -> Date { Date(timeIntervalSince1970: (date.timeIntervalSince1970 * 1000).rounded() / 1000) }
    static func text(_ date: Date) -> String {
        let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.string(from: canonical(date))
    }
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { value, encoder in
            var container = encoder.singleValueContainer(); try container.encode(text(value))
        }
        return encoder
    }
    // `.iso8601` accepts fractional seconds only from Swift 6.2 Foundation (iOS 26);
    // iOS 15-18 reject every millisecond timestamp this encoder writes.
    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer(), value = try container.decode(String.self)
            let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard let date = format.date(from: value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected an ISO 8601 timestamp with fractional seconds.")
            }
            return canonical(date)
        }
        return decoder
    }
}
struct ReleaseHealthSegment {
    let pointer: EverframeNativeExposure
    let configuration: ReleaseHealthConfiguration
    let sdkVersion: String
    let sdkKey: String
    let endpoint: String
    let startedUptime: TimeInterval
    init(configuration: ReleaseHealthConfiguration, sdkVersion: String, sdkKey: String, endpoint: String,
         processLaunchID: UUID, now: Date, uptime: TimeInterval) {
        self.configuration = configuration; self.sdkVersion = sdkVersion; self.sdkKey = sdkKey; self.endpoint = endpoint
        startedUptime = uptime
        pointer = EverframeNativeExposure(exposureID: UUID().uuidString.lowercased(), loadedBuildID: configuration.loadedBuildId,
            loadedBundleStatus: EverframeLoadedBundleStatus(rawValue: configuration.loadedBundleStatus.rawValue)!,
            nativeBuildID: configuration.nativeBuildId, processLaunchID: processLaunchID.uuidString.lowercased(),
            startedAt: ReleaseHealthDate.canonical(now))
    }
    func entry(end: Bool, now: Date, uptime: TimeInterval) throws -> ReleaseHealthEntry {
        let id = UUID(), captured = end ? ReleaseHealthDate.canonical(now) : pointer.startedAt
        let exposure: [String: Any] = ["exposureId": pointer.exposureID, "processLaunchId": pointer.processLaunchID,
            "startedAt": ReleaseHealthDate.text(pointer.startedAt), "platform": "ios", "sdkVersion": sdkVersion,
            "nativeRelease": ["buildId": configuration.nativeBuildId], "loadedBuildId": configuration.loadedBuildId as Any? ?? NSNull(),
            "loadedBundleStatus": configuration.loadedBundleStatus.rawValue, "subject": "anonymous_exposure",
            "coverage": ["policy": "ios-sdk-segment-v1", "sampleRate": 1, "priorQueueLosses": NSNull(), "queueLossAccounting": "unavailable"]]
        var record: [String: Any] = ["schemaVersion": 1, "recordId": id.uuidString.lowercased(), "exposure": exposure,
            "capturedAt": ReleaseHealthDate.text(captured), "phase": end ? "end" : "start", "sequence": end ? 1 : 0,
            "elapsedMs": end ? Int(min(max(0, (uptime - startedUptime) * 1000), 31 * 86400 * 1000)) : 0]
        if end { record["endReason"] = "sdk_stop" }
        return ReleaseHealthEntry(recordID: id, createdAt: captured, sdkKey: sdkKey, endpoint: endpoint,
            body: try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]))
    }
}
