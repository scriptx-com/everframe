// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// One synchronous native entry; retains no captured error or report content.
final class CaptureObservation {
    let owner: ReportDiagnostics.Handle?
    private let path: ReportCapturePath
    var outcome: ReportCaptureOutcome = .failed
    init(_ path: ReportCapturePath) {
        self.owner = ReportDiagnostics.shared.currentHandle()
        self.path = path
    }
    func reject(_ reason: ReportCaptureOutcome) -> Bool { outcome = reason; return false }
    func settle() { owner?.capture(path, outcome) }
}
