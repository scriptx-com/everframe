// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Healthy-process context only. No live rings, identity provider, SDK singleton,
/// or host metadata callbacks are read while building the persisted template.
enum NativeCrashStartupContext {
    static func make(config: EverframeConfig, user: EFUser?, device: DeviceMetadata,
                     endpoint: String) throws -> NativeCrashRecoveryContext {
        let policy = try NativeCrashRedactionSnapshot.capture(config: config.redaction)
        var fields: [String: String] = [
            "app.name": device.bundleIdentifier ?? "unknown",
            "app.version": config.release ?? device.appVersion ?? "unknown",
            "app.build": device.appBuild ?? "unknown",
            "device.model": device.model, "device.os": device.osName,
            "device.osVersion": device.osVersion, "device.locale": device.locale,
            "device.timezone": device.timezone,
            "device.screen.width": String(device.screenWidth),
            "device.screen.height": String(device.screenHeight),
            "device.pixelRatio": String(device.pixelRatio),
        ]
        fields["user.id"] = user?.id
        fields["user.email"] = user?.email
        fields["user.displayName"] = user?.displayName
        // Like every other report path, keep the declared user and app/device
        // identity verbatim: ingest keys people by user id or email, so a masked
        // value would merge users or overwrite a stored email. The frozen policy
        // redacts the recovered crash record's own strings.
        let placeholder = UUID(uuidString: "00000000-0000-4000-8000-000000000000")!
        let built = try EnvelopeBuilder(vitalsStamp: { nil }).buildEncoded(
            reportId: placeholder, sdkVersion: Everframe.SDK_VERSION, extra: fields, source: .crash)
        let envelope = try EverframeReportEnvelope(data: built.bytes).with(submittedAt: Date(timeIntervalSince1970: 0))
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]
        return try NativeCrashRecoveryContext(sdkKey: config.appId, endpoint: endpoint, identitySubject: nil,
            envelopeTemplate: encoder.encode(envelope), redaction: policy)
    }
}
