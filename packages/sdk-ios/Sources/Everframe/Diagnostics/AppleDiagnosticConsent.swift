// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Capture authorization only. Every process must explicitly enable collection
/// and delivery. Call `setAppleDiagnosticsEnabled(false)` to withdraw consent.
public enum AppleDiagnosticConsentScope: Sendable {
    case currentProcess
    /// Covers reporting periods across restarts for seven days after reaffirmation.
    case installation
}

/// This ID is local authority, never an installation identifier on the wire.
struct AppleDiagnosticGrant: Codable, Sendable {
    let id: UUID
    let begin: Date
    var authorizedThrough: Date
    var lastObservedAt: Date
    let ownerDigest: String
    let context: AppleDiagnosticContext
    var closed: Bool

    func validate() throws {
        guard begin.timeIntervalSince1970.isFinite, authorizedThrough.timeIntervalSince1970.isFinite,
              lastObservedAt.timeIntervalSince1970.isFinite, begin <= authorizedThrough, begin <= lastObservedAt,
              authorizedThrough <= lastObservedAt.addingTimeInterval(AppleDiagnosticStore.lifetime),
              ownerDigest == (try context.ownerDigest()) else { throw AppleDiagnosticStore.Failure.invalid }
    }
}

extension AppleDiagnosticContext {
    /// Deliberately excludes per-launch context.device. Its original value stays
    /// in the grant's template, while MetricKit supplies the reporting-period OS.
    func ownerDigest() throws -> String {
        _ = try frozen.encoded()
        guard frozen.identitySubject == nil, frozen.releaseHealthExposure == nil,
              !applicationVersion.isEmpty, applicationVersion.utf8.count <= 128,
              !applicationBuild.isEmpty, applicationBuild.utf8.count <= 128,
              let template = try JSONSerialization.jsonObject(with: frozen.envelopeTemplate) as? [String: Any],
              let protocolVersion = template["protocolVersion"], let sdk = template["sdk"] as? [String: Any],
              let context = template["context"] as? [String: Any], let app = context["app"] as? [String: Any],
              (template["reporter"] as? [String: Any])?["user"] == nil else { throw AppleDiagnosticStore.Failure.invalid }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let redaction = try JSONSerialization.jsonObject(with: encoder.encode(frozen.redaction))
        let value: [String: Any] = ["sdkKey": frozen.sdkKey, "endpoint": frozen.endpoint,
            "applicationVersion": applicationVersion, "applicationBuild": applicationBuild,
            "protocolVersion": protocolVersion, "sdk": sdk, "app": app, "redaction": redaction]
        return NativeCrashRecoveryJournal.hash(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    }

    /// The same app facts as DeviceMetadata.snapshot(), without UIKit/main actor
    /// work. Placeholder device facts are excluded from ownerDigest by design.
    static func ownerDigest(config: EverframeConfig, endpoint: String, bundle: Bundle = .main) throws -> String {
        let info = bundle.infoDictionary ?? [:]
        guard let version = info["CFBundleShortVersionString"] as? String,
              let build = info["CFBundleVersion"] as? String else { throw AppleDiagnosticStore.Failure.invalid }
        let device = DeviceMetadata(model: "unknown", osName: "unknown", osVersion: "unknown", locale: "unknown", timezone: "unknown",
            appVersion: version, appBuild: build, bundleIdentifier: bundle.bundleIdentifier)
        return try AppleDiagnosticContext(frozen: NativeCrashStartupContext.make(config: config, user: nil, device: device, endpoint: endpoint),
            applicationVersion: version, applicationBuild: build).ownerDigest()
    }
}
