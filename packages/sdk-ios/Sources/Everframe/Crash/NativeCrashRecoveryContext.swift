// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit
import EverframeProtocol

/// Already-captured and redacted envelope facts plus routing and frozen policy.
/// Callers persist this only through NativeCrashContextStore's authenticated encryption.
struct NativeCrashRecoveryContext: Codable {
    enum Failure: Error { case invalidContext, oversized, unsupported }
    let schemaVersion: Int
    let sdkKey: String
    let endpoint: String
    let identitySubject: String?
    let envelopeTemplate: Data
    let redaction: NativeCrashRedactionSnapshot

    init(sdkKey: String, endpoint: String, identitySubject: String?,
         envelopeTemplate: Data, redaction: NativeCrashRedactionSnapshot) throws {
        schemaVersion = 1; self.sdkKey = sdkKey; self.endpoint = endpoint
        self.identitySubject = identitySubject; self.envelopeTemplate = envelopeTemplate
        self.redaction = redaction
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
            let envelope = template.with(payload: template.payload.with(crash: record.crash),
                reportID: record.reportID.uuidString.lowercased(), source: .crash, submittedAt: record.crash.occurredAt)
            let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]
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
        do {
            let template = try EverframeReportEnvelope(data: envelopeTemplate)
            guard template.attachments.isEmpty else { throw Failure.invalidContext }
            _ = try redaction.compiled()
        } catch let error as Failure { throw error }
        catch { throw Failure.invalidContext }
    }
}
