// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
enum NativeVideoReportBudget {
    /// The receiver allows six file parts including the envelope, and counts
    /// their combined payload bytes. Do not let optional replay reject a report.
    static func omissionReason(envelopeBytes: Int, attachmentBytes: [Int]) -> String? {
        guard attachmentBytes.count <= 5 else { return "replay_part_limit" }
        guard envelopeBytes >= 0, envelopeBytes <= 25_000_000 else { return "replay_report_budget" }
        var remaining = 25_000_000 - envelopeBytes
        for bytes in attachmentBytes {
            guard bytes >= 0, bytes <= remaining else { return "replay_report_budget" }
            remaining -= bytes
        }
        return nil
    }
}
