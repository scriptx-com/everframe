// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Smoke test for the reporter flow's continuation plumbing. We exercise the
// cancellation path through EFReporterPresenter.openAndAwait without standing
// up an actual UIWindowScene — on macOS host runners the
// connectedScenes list is empty, so present(rootController:) is a no-op. We
// rely on the openAndAwait early-return semantics + the __resolveForTesting
// seam to round-trip the continuation.
import Testing
import Foundation
#if canImport(UIKit) && !os(tvOS)
import UIKit
@testable import EverframeReporterUI
@testable import EverframeKit
#endif

@MainActor
struct ReporterFlowSmokeTest {
    #if canImport(UIKit) && !os(tvOS)

    @Test func cancellationRoundTripsThroughContinuation() async throws {
        // Drive openAndAwait + resolve cancellation in parallel. We can't
        // present the actual reporter window without a UIWindowScene on a
        // headless macOS test host, but the continuation/resolver path is
        // platform-agnostic.
        let task = Task { @MainActor () -> ReportResult in
            try await EFReporterPresenter.openAndAwait()
        }
        // Yield a few times so openAndAwait gets to the continuation block.
        for _ in 0..<5 { await Task.yield() }
        EFReporterPresenter.__resolveForTesting(.cancelled)
        let result = try await task.value
        if case .cancelled = result {
            // OK
        } else {
            Issue.record("expected .cancelled, got \(result)")
        }
    }

    @Test func installResolverWiresReportAPIOpen() {
        EFReporterPresenter.installResolver()
        #expect(ReportAPI.__resolver != nil)
    }

    #endif
}
