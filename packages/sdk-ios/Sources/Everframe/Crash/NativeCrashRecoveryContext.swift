// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit
import EverframeProtocol

/// Already-captured and redacted envelope facts plus routing and frozen policy.
/// Callers persist this only through NativeCrashContextStore's authenticated encryption.
struct NativeCrashRecoveryContext: Codable, Sendable {
    enum Failure: Error { case invalidContext, oversized, unsupported }
    let schemaVersion: Int
    let sdkKey: String
    let endpoint: String
    let identitySubject: String?
    let envelopeTemplate: Data
    let redaction: NativeCrashRedactionSnapshot
    private let releaseHealthExposureBytes: Data?
    var releaseHealthExposure: EverframeNativeExposure? {
        releaseHealthExposureBytes.flatMap { try? EverframeNativeExposure(data: $0) }
    }

    init(sdkKey: String, endpoint: String, identitySubject: String?,
         envelopeTemplate: Data, redaction: NativeCrashRedactionSnapshot,
         releaseHealthExposure: EverframeNativeExposure? = nil) throws {
        schemaVersion = 1; self.sdkKey = sdkKey; self.endpoint = endpoint
        self.identitySubject = identitySubject; self.envelopeTemplate = envelopeTemplate
        self.redaction = redaction
        releaseHealthExposureBytes = try releaseHealthExposure.map { try ReleaseHealthDate.encoder().encode($0) }
        try validate()
    }
    func encoded() throws -> Data {
        try validate()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(self)
        guard bytes.count <= 64 * 1024 else { throw Failure.oversized }
        return bytes
    }
    static func decode(_ data: Data) throws -> Self {
        guard data.count <= 64 * 1024 else { throw Failure.oversized }
        do {
            let value = try JSONDecoder().decode(Self.self, from: data)
            try value.validate()
            return value
        } catch let error as Failure { throw error }
        catch { throw Failure.invalidContext }
    }
    func entry(for record: NativeCrashRecord) throws -> OutboxEntry {
        try validate()
        do {
            let template = try EverframeReportEnvelope(data: envelopeTemplate)
            var crash = record.crash
            if let exposure = releaseHealthExposure, let contextID = record.contextID, let native = crash.native {
                let evidence = EverframeNativeCrashReleaseHealthEvidence(attribution: .immutableFatalContext,
                    contextID: contextID.uuidString.lowercased(), exposure: exposure, version: 1)
                crash = crash.with(native: .some(native.with(releaseHealthEvidence: .some(evidence))))
            }
            let envelope = template.with(payload: template.payload.with(crash: crash),
                reportID: record.reportID.uuidString.lowercased(), source: .crash, submittedAt: record.crash.occurredAt)
            let encoder = releaseHealthExposureBytes == nil ? JSONEncoder() : ReleaseHealthDate.encoder()
            if releaseHealthExposureBytes == nil { encoder.dateEncodingStrategy = .iso8601 }
            encoder.outputFormatting = [.sortedKeys]
            let bytes = try encoder.encode(envelope)
            guard bytes.count <= 512 * 1024 else { throw Failure.oversized }
            let idempotency = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            return OutboxEntry(reportId: record.reportID, createdAt: record.crash.occurredAt,
                envelopeBytes: bytes, idempotencyKey: idempotency, attachmentRefs: [],
                sdkKey: sdkKey, endpoint: endpoint, identitySubject: identitySubject)
        } catch let error as Failure { throw error }
        catch { throw Failure.invalidContext }
    }
    private func validate() throws {
        guard schemaVersion == 1 else { throw Failure.unsupported }
        guard !sdkKey.isEmpty, sdkKey.utf8.count <= 4096, !sdkKey.contains(where: { $0.isNewline }),
              endpoint.utf8.count <= 4096, let url = URLComponents(string: endpoint),
              ["http", "https"].contains(url.scheme), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.fragment == nil,
              identitySubject.map({ !$0.isEmpty && $0.utf8.count <= 1024 && !$0.contains(where: { $0.isNewline }) }) ?? true
        else { throw Failure.invalidContext }
        guard envelopeTemplate.count <= 32 * 1024 else { throw Failure.oversized }
        if let bytes = releaseHealthExposureBytes {
            guard let exposure = releaseHealthExposure,
                  [exposure.exposureID, exposure.processLaunchID].allSatisfy({ UUID(uuidString: $0)?.uuidString.lowercased() == $0 }),
                  let wire = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
                  wire["startedAt"] as? String == ReleaseHealthDate.text(exposure.startedAt),
                  let status = ReleaseHealthConfiguration.LoadedBundleStatus(rawValue: exposure.loadedBundleStatus.rawValue) else { throw Failure.invalidContext }
            _ = try ReleaseHealthConfiguration(nativeBuildId: exposure.nativeBuildID,
                loadedBuildId: exposure.loadedBuildID, loadedBundleStatus: status)
        }
        do {
            let template = try EverframeReportEnvelope(data: envelopeTemplate)
            guard template.attachments.isEmpty else { throw Failure.invalidContext }
            _ = try redaction.compiled()
        } catch let error as Failure { throw error }
        catch { throw Failure.invalidContext }
    }
}
