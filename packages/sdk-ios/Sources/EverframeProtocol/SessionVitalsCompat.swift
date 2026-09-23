// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

// Regeneration adds optional wire fields as required Swift initializer labels.
// Keep existing Everframe SDK call sites valid without inventing session/vitals data.
public extension EverframeReportEnvelope {
    init(attachments: [EverframeAttachment], captureControl: EverframeCaptureControl, captures: EverframeCaptures,
         context: EverframeContext, payload: EverframePayload, protocolVersion: EverframeProtocolVersion,
         reporter: EverframeReporter, reportID: String, sdk: EverframeSDK, source: EverframeReportEnvelopeSource?,
         submittedAt: Date) {
        self.init(attachments: attachments, captureControl: captureControl, captures: captures,
                  context: context, payload: payload, protocolVersion: protocolVersion,
                  reporter: reporter, reportID: reportID, sdk: sdk, sessionID: nil,
                  source: source, submittedAt: submittedAt)
    }
}
