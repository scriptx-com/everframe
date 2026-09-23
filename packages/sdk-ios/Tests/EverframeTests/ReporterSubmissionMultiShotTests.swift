// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure, network-free tests for the Task 10 wire-naming helpers extracted
// from `ReporterSubmission.submit(_:)` — `partName(kind:index:)` and
// `buildAttachmentPlan(annotatedFlags:)`. Both are `nonisolated static func`
// on the `@MainActor` `ReporterSubmission` enum specifically so these plain
// synchronous test functions can call them without `await`.
//
// UIKIT-ONLY (false pass on macOS): `ReporterSubmission` itself lives inside
// `#if canImport(UIKit)` (ReporterSubmission.swift:33) — the type doesn't
// exist at all when `swift test --package-path packages/sdk-ios` runs on a
// plain macOS host (no UIKit there), so this whole file is gated the same
// way, matching the established convention (see
// BreadcrumbTapNavAdaptersTests.swift, RnReplayAttachmentTests.swift). A
// macOS `swift test --filter ReporterSubmissionMultiShotTests` run reports
// "0 tests, 0 failures" — green, but proves nothing. Real evidence comes
// from the iOS Simulator suite: `xcodebuild test -scheme Everframe-Package
// -destination 'platform=iOS Simulator,name=<sim>'` (run from
// packages/sdk-ios), where these ARE plain pure-function tests (no UIWindow
// / UIApplication dependency at all — the gate is inherited from the type,
// not from anything these two helpers touch).
#if canImport(UIKit)
import Testing
@testable import EverframeKit
@testable import EverframeProtocol

struct ReporterSubmissionMultiShotTests {
    @Test func shotOneKeepsBareNames() {
        #expect(ReporterSubmission.partName(kind: "screenshot", index: 0) == "screenshot")
        #expect(ReporterSubmission.partName(kind: "annotated-screenshot", index: 0) == "annotated-screenshot")
    }

    @Test func laterShotsAreSuffixedOneBased() {
        #expect(ReporterSubmission.partName(kind: "screenshot", index: 1) == "screenshot-2")
        #expect(ReporterSubmission.partName(kind: "annotated-screenshot", index: 4) == "annotated-screenshot-5")
    }

    @Test func kindFollowsAnnotatedFlagPerShot() {
        let plan = ReporterSubmission.buildAttachmentPlan(annotatedFlags: [true, false, true])
        #expect(plan.map(\.partName) == ["annotated-screenshot", "screenshot-2", "annotated-screenshot-3"])
        #expect(plan.map(\.kind) == [.annotatedScreenshot, .screenshot, .annotatedScreenshot])
    }

    @Test func emptyFlagsProduceEmptyPlan() {
        #expect(ReporterSubmission.buildAttachmentPlan(annotatedFlags: []).isEmpty)
    }

    /// Privacy regression (final review Fix 1): deleting every screenshot
    /// before submit MUST ship zero screenshot attachments — never a
    /// fallback to the raw, pre-deletion capture. `submit(_:)` zips this
    /// plan 1:1 against `inputs.shots` in a `for` loop
    /// (ReporterSubmission.swift ~line 270); an empty plan here means that
    /// loop's body never runs, so no envelope `Attachment` and no
    /// multipart part gets appended for a screenshot. The separate
    /// session-replay attachment (built by `buildReplayAttachment()`, an
    /// independent code path) is unaffected either way.
    @Test func emptyShotsShipNoScreenshotAttachments() {
        let plan = ReporterSubmission.buildAttachmentPlan(annotatedFlags: [])
        #expect(plan.isEmpty)
        #expect(plan.map(\.partName).isEmpty)
        #expect(plan.map(\.kind).isEmpty)
    }
}
#endif
