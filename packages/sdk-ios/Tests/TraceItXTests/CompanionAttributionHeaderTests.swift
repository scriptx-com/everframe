// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The companion attribution token has to reach the ingest POST as
// `X-TX-Companion-Attribution` (spec 2026-08-07) — that header is the only
// thing that credits a dashboard-filed report to the person who filed it.
// These tests drive the real `ReportSubmitter` → `MultipartUploader` hop
// against a stub URLProtocol and read the header off the outbound request.
//
// The remaining hop, `CompanionCaptureBridge` → `ReporterSubmission.Inputs
// .companionAttribution`, cannot be executed on this host: both files are
// entirely `#if canImport(UIKit)` and do not exist in the macOS test slice.
// `CompanionCaptureBridgeSourceGate` at the bottom of this file covers it as a
// SOURCE gate instead — see the reasoning there.
import Testing
import Foundation
@testable import TraceItXKit

/// Private to this suite so no other test's session can clobber the capture.
private final class CompanionAttrStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var capturedRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        CompanionAttrStubURLProtocol.capturedRequest = request
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Suite(.serialized)
struct CompanionAttributionHeaderTests {

    private func makeSubmitter() -> ReportSubmitter {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [CompanionAttrStubURLProtocol.self]
        return ReportSubmitter(
            config: TraceItXConfig(appId: "sdk_key"),
            session: URLSession(configuration: cfg))
    }

    @Test func companionSubmit_sendsTheAttributionHeader() async throws {
        CompanionAttrStubURLProtocol.capturedRequest = nil
        let submitter = makeSubmitter()

        _ = try await submitter.submit(
            envelopeBytes: Data("{}".utf8),
            idempotencyKey: "idem-1",
            attachments: [],
            companionAttribution: "attr_tok_1")

        let header = CompanionAttrStubURLProtocol.capturedRequest?
            .value(forHTTPHeaderField: "X-TX-Companion-Attribution")
        #expect(header == "attr_tok_1")
    }

    @Test func ordinarySubmit_sendsNoAttributionHeader() async throws {
        // Every non-companion submit must stay byte-for-byte what it was
        // before this feature existed.
        CompanionAttrStubURLProtocol.capturedRequest = nil
        let submitter = makeSubmitter()

        _ = try await submitter.submit(
            envelopeBytes: Data("{}".utf8),
            idempotencyKey: "idem-2",
            attachments: [])

        let captured = CompanionAttrStubURLProtocol.capturedRequest
        #expect(captured != nil)
        #expect(captured?.value(forHTTPHeaderField: "X-TX-Companion-Attribution") == nil)
        // Sanity: the request we inspected really is the ingest POST.
        #expect(captured?.value(forHTTPHeaderField: "Authorization") == "Bearer sdk_key")
    }
}

/// Source-level gate on the ONE line that joins the relay client's attribution
/// token to the submit path.
///
/// WHY A SOURCE GATE. `CompanionCaptureBridge.swift` is entirely
/// `#if canImport(UIKit)`, so on the macOS `swift test` slice — the only slice
/// that runs tests at all in `.github/workflows/swift.yml` — the file does not
/// compile and no behavioural test can reach it. The two suites above and
/// `RelayWSClientCompanionTests` cover the hops on either side (`frame` →
/// `getCompanionAttribution()`, and `ReportSubmitter` → `MultipartUploader` →
/// header) but nothing covered the join between them: the assignment could be
/// deleted and the entire Swift suite stayed green. Compile-verification via the
/// tvOS build proves the line type-checks, not that it is there — deleting it
/// also compiles, because the parameter has a default.
///
/// Android has a real behavioural test for the identical shape
/// (`CompanionAttributionFlowTest`), so this is a platform gap, not a design
/// choice. This gate is the cheapest parity fix, in the same spirit as
/// `packages/sdk-react-native/__tests__/companion-bridge-wiring.spec.ts`.
///
/// It lives in THIS file because `.github/workflows/swift.yml` filters to
/// `CompanionAnnounceTests|RelayWSClientCompanionTests|CompanionAttributionHeaderTests`;
/// a new top-level suite name would not run in CI. Renaming this suite means
/// widening that filter.
///
/// Replace this with a real test the moment `CompanionCaptureBridge` becomes
/// reachable from an executed test target (an iOS-simulator test slice would do
/// it).
@Suite struct CompanionAttributionHeaderTests_CompanionCaptureBridgeSourceGate {

    /// `<package root>/Sources/TraceItX/Companion/CompanionCaptureBridge.swift`,
    /// resolved from this file rather than the process CWD (which `swift test`
    /// does not guarantee).
    private static func bridgeSource() throws -> String {
        let thisFile = URL(fileURLWithPath: #filePath)
        // …/Tests/TraceItXTests/ThisFile.swift → …/
        let packageRoot = thisFile
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
        let bridge = packageRoot
            .appendingPathComponent("Sources/TraceItX/Companion/CompanionCaptureBridge.swift")
        return try String(contentsOf: bridge, encoding: .utf8)
    }

    /// Drops `//` line comments so the gate reads CODE, not prose — the file
    /// documents this very field in the comment immediately above it, and an
    /// unstripped match would pass on the comment alone.
    private static func strippingLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let slashes = line.range(of: "//") else { return line }
                return line[line.startIndex..<slashes.lowerBound]
            }
            .joined(separator: "\n")
    }

    @Test func bridgeJoinsTheAttributionTokenOntoReporterSubmissionInputs() throws {
        let code = Self.strippingLineComments(try Self.bridgeSource())
        let joined = code.range(
            of: #"companionAttribution:\s*stash\.companionAttribution"#,
            options: .regularExpression)
        #expect(
            joined != nil,
            """
            CompanionCaptureBridge.swift no longer passes \
            `companionAttribution: stash.companionAttribution` into \
            ReporterSubmission.Inputs. Without that line every companion-filed \
            report reaches ingest with no X-TX-Companion-Attribution header and \
            is silently credited to nobody — and nothing else in the Swift suite \
            notices, which is exactly why this gate exists.
            """)
    }

    /// PR-fix 1 — the token must be SNAPSHOTTED when `report.request` arrives.
    /// Reading it at submit time is the defect: one `RelayWSClient` instance
    /// serves successive dashboard users (a release force-closes only the
    /// phone leg, so the next attach re-bonds the same TV socket and
    /// overwrites `attributionToken`), so a submit still composing when
    /// somebody else attaches would consume THEIR single-use token.
    @Test func bridgeSnapshotsTheTokenIntoTheCaptureStashAtRequestTime() throws {
        let code = Self.strippingLineComments(try Self.bridgeSource())

        let snapshot = code.range(
            of: #"let companionAttribution = self\.client\?\.getCompanionAttribution\(\)"#,
            options: .regularExpression)
        #expect(
            snapshot != nil,
            """
            CompanionCaptureBridge.swift no longer snapshots \
            `self.client?.getCompanionAttribution()` in the \
            `.traceItXCompanionReportRequested` observer. The snapshot must \
            happen synchronously there — that is the only moment the live \
            session is guaranteed to still be the one that asked for this \
            report.
            """)

        let carried = code.range(
            of: #"companionAttribution:\s*companionAttribution"#,
            options: .regularExpression)
        #expect(
            carried != nil,
            """
            The snapshotted token is no longer carried into the capture stash, \
            so nothing reaches the submit.
            """)
    }

    /// The negative half of the gate: the submit composition must NOT reach
    /// back into the live client. This is the line the fix removed, and the
    /// one a well-meaning refactor is most likely to put back.
    ///
    /// PR-fix 3 — this gate used to forbid one LITERAL form,
    /// `companionAttribution: self.client?.getCompanionAttribution()`, which
    /// is only the shape the defect happened to have. Extracting the read into
    /// a helper (`private func liveAttribution()`) and assigning it onto the
    /// stash at submit time reinstates the exact defect and matches no literal
    /// at all — it passed all three gates as written. The counting assertion
    /// below is what actually holds the property: the bridge may read the live
    /// client from ONE place in the whole file, and that place must be the
    /// `report.request` snapshot. Any second read — helper, wrapper, or
    /// inlined — is a second read no matter what it is spelled.
    @Test func bridgeDoesNotReadTheLiveClientWhenComposingASubmit() throws {
        let code = Self.strippingLineComments(try Self.bridgeSource())

        // 1. Exactly one live read exists anywhere in the file.
        var reads = 0
        var cursor = code.startIndex
        while let hit = code.range(
            of: "getCompanionAttribution", range: cursor..<code.endIndex) {
            reads += 1
            cursor = hit.upperBound
        }
        #expect(
            reads == 1,
            """
            CompanionCaptureBridge.swift reads the relay client's attribution \
            token \(reads) times; exactly one read is allowed, the snapshot in \
            the `.traceItXCompanionReportRequested` observer. A second read — \
            including one hidden behind a helper and called at submit time — \
            is the PR-fix-1 defect again: by then the client may be serving a \
            different dashboard user, so the report is credited to them and \
            their own single-use token is consumed.
            """)

        // 2. …and that one read is the snapshot, not something else that
        //    happens to be the only one left.
        let snapshot = code.range(
            of: #"let companionAttribution = self\.client\?\.getCompanionAttribution\(\)"#,
            options: .regularExpression)
        #expect(
            snapshot != nil,
            """
            The single remaining read of `getCompanionAttribution()` is not \
            the request-time snapshot. Together with the count above this is \
            what pins the read to the observer: one read, and it is that one.
            """)

        // 3. The original literal gate, kept because it names the exact line
        //    the fix deleted and gives the clearest failure message if it
        //    comes back verbatim.
        let lateRead = code.range(
            of: #"companionAttribution:\s*self\.client\?\.getCompanionAttribution\(\)"#,
            options: .regularExpression)
        #expect(
            lateRead == nil,
            """
            CompanionCaptureBridge.swift composes ReporterSubmission.Inputs \
            with a LIVE read of the relay client's attribution token. \
            Snapshot at `report.request` and carry it through the capture \
            stash instead.
            """)
    }
}
