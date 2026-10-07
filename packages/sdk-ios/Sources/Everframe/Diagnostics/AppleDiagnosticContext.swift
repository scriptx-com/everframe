// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit
import EverframeProtocol

struct AppleDiagnosticContext: Sendable {
    let frozen: NativeCrashRecoveryContext
    let applicationVersion: String
    let applicationBuild: String

    func accepts(_ candidate: AppleDiagnosticCandidate, since begin: Date, now: Date) -> Bool {
        guard candidate.begin >= begin, candidate.begin <= candidate.end, candidate.end <= now,
              candidate.end.timeIntervalSince(candidate.begin) <= 86400,
              candidate.applicationVersion == applicationVersion, candidate.applicationBuild == applicationBuild,
              !applicationVersion.isEmpty, applicationVersion.utf8.count <= 128,
              !applicationBuild.isEmpty, applicationBuild.utf8.count <= 128,
              !candidate.osVersion.isEmpty, candidate.osVersion.utf8.count <= 128 else { return false }
        if candidate.kind == "hang_batch" {
            return candidate.exits.isEmpty && (1...8).contains(candidate.hangs.count) && candidate.hangs.allSatisfy {
                $0.durationMs.isFinite && $0.durationMs > 0 && $0.durationMs <= 86400000 && $0.stack.frames.count <= 64
                    && (($0.stack.status == "available") == !$0.stack.frames.isEmpty)
            }
        }
        return candidate.kind == "app_exit_summary" && candidate.hangs.isEmpty && (1...16).contains(candidate.exits.count)
            && candidate.exits.allSatisfy { $0.count > 0 && $0.count <= 2147483647 }
            && Set(candidate.exits.map { $0.state + "/" + $0.reason }).count == candidate.exits.count
    }

    func hash(_ candidate: AppleDiagnosticCandidate) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .millisecondsSince1970
        return NativeCrashRecoveryJournal.hash(Data((frozen.sdkKey + "\n" + frozen.endpoint + "\n").utf8) + (try encoder.encode(candidate)))
    }

    func entry(_ candidate: AppleDiagnosticCandidate, ownershipID: UUID, now: Date) throws -> OutboxEntry {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        let projected = try JSONSerialization.jsonObject(with: encoder.encode(candidate)) as! [String: Any]
        let template = try JSONSerialization.jsonObject(with: frozen.envelopeTemplate) as! [String: Any]
        let id = UUID(), formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let collected = formatter.string(from: now)
        let redact = try frozen.redaction.compiled()
        var diagnostic: [String: Any] = ["version": 1, "evidenceId": id.uuidString.lowercased(),
            "ownershipId": ownershipID.uuidString.lowercased(), "kind": candidate.kind,
            "provenance": "apple_metrickit", "scope": "reporting_interval", "outcome": "unknown",
            "interval": ["begin": formatter.string(from: candidate.begin), "end": formatter.string(from: candidate.end)],
            "collectedAt": collected, "truncated": candidate.truncated,
            "attribution": ["process": "unavailable", "release": "frozen", "session": "unavailable", "webExposure": "unavailable"],
            "apple": ["applicationVersion": redact(applicationVersion), "applicationBuild": redact(applicationBuild),
                      "osVersion": redact(candidate.osVersion)]]
        if candidate.kind == "hang_batch" {
            // Names are optional evidence: discard a frame if frozen custom
            // redaction changes it instead of persisting an unsafe replacement.
            let hangs = candidate.hangs.map { hang in
                let frames = hang.stack.frames.filter { redact($0.binaryName) == $0.binaryName }
                let changed = frames.count != hang.stack.frames.count
                return AppleDiagnosticHang(durationMs: hang.durationMs, stack: .init(
                    status: frames.isEmpty && changed ? "unavailable" : hang.stack.status,
                    truncated: hang.stack.truncated || changed, frames: frames))
            }
            diagnostic["hangs"] = try JSONSerialization.jsonObject(with: encoder.encode(hangs))
        }
        else { diagnostic["exits"] = projected["exits"] }
        var value: [String: Any] = ["reportId": id.uuidString.lowercased(), "submittedAt": collected, "source": "diagnostic",
            "reporter": ["title": candidate.kind == "hang_batch" ? "Apple hang batch" : "Apple exit summary", "description": ""],
            "captures": ["screenshot": false, "uiTree": false, "focus": false, "logs": false, "network": false, "breadcrumbs": false],
            "captureControl": ["included": [], "excluded": []], "payload": ["appleDiagnostic": diagnostic], "attachments": []]
        for field in ["protocolVersion", "sdk", "context"] { value[field] = template[field] }
        // Frozen context contains only the startup app/device snapshot. Never
        // copy reporter, session, arbitrary payload or live capture collections.
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard bytes.count <= 256 * 1024 else { throw AppleDiagnosticStore.Failure.capacity }
        _ = try EverframeReportEnvelope(data: bytes)
        return .init(reportId: id, createdAt: Date(timeIntervalSince1970: floor(now.timeIntervalSince1970)), envelopeBytes: bytes,
                     idempotencyKey: NativeCrashRecoveryJournal.hash(bytes), attachmentRefs: [],
                     sdkKey: frozen.sdkKey, endpoint: frozen.endpoint, identitySubject: nil)
    }
}
