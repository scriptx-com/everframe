// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

// Regeneration adds optional wire fields as required Swift initializer labels.
// Keep existing SDK call sites valid without inventing session/vitals data.
public extension ReportEnvelope {
    init(attachments: [Attachment], captureControl: CaptureControl, captures: Captures,
         context: Context, payload: Payload, protocolVersion: ProtocolVersion,
         reporter: Reporter, reportID: String, sdk: SDK, source: ReportEnvelopeSource?,
         submittedAt: Date) {
        self.init(attachments: attachments, captureControl: captureControl, captures: captures,
                  context: context, payload: payload, protocolVersion: protocolVersion,
                  reporter: reporter, reportID: reportID, sdk: sdk, sessionID: nil,
                  source: source, submittedAt: submittedAt)
    }
}
