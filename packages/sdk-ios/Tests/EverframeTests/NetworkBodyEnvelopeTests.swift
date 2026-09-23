// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 10: payload.networkBodies wiring through EnvelopeBuilder.buildEncoded
// (includeNetwork freeze/kill lifecycle lives in ReporterSubmission /
// Everframe.swift — this file covers the builder-level shape contract, the
// kill()-zeroize posture, and the wire-shape parity fixture shared with the
// protocol package). Mirrors EnvelopeBuilderTests' Task-6 breadcrumbs suite
// and KillSwitchTests' `killZeroizesBreadcrumbBufferIncludingFrozenSnapshot`
// pattern.
import Testing
import Foundation
import EverframeProtocol
@testable import EverframeKit

struct NetworkBodyEnvelopeTests {
    private func makeBuilder() -> EnvelopeBuilder {
        EnvelopeBuilder(redactor: RedactionEngine())
    }

    private func entry(ref: Double, t: Double, reqBody: String? = nil, resBody: String? = nil) -> EverframeNetworkBody {
        EverframeNetworkBody(
            ref: ref,
            reqBody: reqBody,
            reqBodyBytes: reqBody.map { Double($0.utf8.count) },
            reqBodySkipped: nil,
            reqBodyTruncated: nil,
            reqHeaders: nil,
            resBody: resBody,
            resBodyBytes: resBody.map { Double($0.utf8.count) },
            resBodySkipped: nil,
            resBodyTruncated: nil,
            resHeaders: nil,
            t: t
        )
    }

    /// A shipped `network` crumb carrying `data.reqId` — the encode-boundary
    /// linkage filter (F14) only lets a body through when one of these
    /// exists for its `ref` in the FINAL trimmed breadcrumb chain.
    private func networkCrumb(reqId: Int, seq: Int, t: Double = 1_700_000_000_000) -> EverframeBreadcrumb {
        EverframeBreadcrumb(
            data: BreadcrumbRingBuffer.coerceHostData(["reqId": reqId]),
            kind: .network, level: .info, message: "GET https://example.com \(reqId)",
            seq: seq, t: t, truncated: nil
        )
    }

    @Test func envelopeEmitsBodiesAndIncludedMarker() throws {
        let builder = makeBuilder()
        let entries = [
            entry(ref: 1, t: 1, reqBody: "{\"q\":1}", resBody: "{\"ok\":true}"),
            entry(ref: 2, t: 2, resBody: "plain text body"),
        ]
        let crumbs = [networkCrumb(reqId: 1, seq: 0), networkCrumb(reqId: 2, seq: 1)]
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "everframe-ios", sdkVersion: "t",
            breadcrumbs: crumbs, networkBodies: entries
        )
        let json = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let payload = json["payload"] as! [String: Any]
        #expect((payload["networkBodies"] as? [[String: Any]])?.count == 2)
        let cc = json["captureControl"] as! [String: Any]
        #expect((cc["included"] as! [String]).contains("networkBodies"))
    }

    @Test func noBodiesMeansNoChannelAndNoMarker() throws {
        let builder = makeBuilder()

        // nil (default) — no `networkBodies:` argument at all.
        let (bytesNil, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "everframe-ios", sdkVersion: "t"
        )
        let jsonNil = try JSONSerialization.jsonObject(with: bytesNil) as! [String: Any]
        let payloadNil = jsonNil["payload"] as! [String: Any]
        #expect(payloadNil["networkBodies"] == nil)
        let ccNil = jsonNil["captureControl"] as! [String: Any]
        #expect(!(ccNil["included"] as! [String]).contains("networkBodies"))

        // Explicit empty array — same as nil.
        let (bytesEmpty, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "everframe-ios", sdkVersion: "t",
            networkBodies: []
        )
        let jsonEmpty = try JSONSerialization.jsonObject(with: bytesEmpty) as! [String: Any]
        let payloadEmpty = jsonEmpty["payload"] as! [String: Any]
        #expect(payloadEmpty["networkBodies"] == nil)
        let ccEmpty = jsonEmpty["captureControl"] as! [String: Any]
        #expect(!(ccEmpty["included"] as! [String]).contains("networkBodies"))
    }

    /// GDPR/kill-switch posture parity: kill() must zeroize BOTH
    /// NetworkBodyRingBuffer.shared (live + any frozen snapshot) AND
    /// NetworkRingBuffer.shared (pre-existing gap this task closes). Follows
    /// KillSwitchTests.killZeroizesBreadcrumbBufferIncludingFrozenSnapshot's
    /// start()→seed→kill()→assert-empty→restore shape.
    // Round-6 review Finding F31: drives `Everframe.shared` (start/kill) and
    // `NetworkBodyRingBuffer.shared`/`NetworkRingBuffer.shared` for real —
    // wrapped in `withGlobalCaptureStateLock` so it cannot interleave with
    // any other suite doing the same (see
    // Helpers/GlobalCaptureStateTestLock.swift).
    @Test func killZeroizesBodyAndNetworkBuffers() async {
        await withGlobalCaptureStateLock {
            NetworkBodyRingBuffer.shared.clear()
            NetworkRingBuffer.shared.clear()
            let config = EverframeConfig(
                appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU",
                capture: CaptureConfig(logs: false)
            )
            try? Everframe.shared.start(config: config)

            NetworkBodyRingBuffer.shared.append(entry(ref: 1, t: 1, resBody: "pre-kill-live"))
            NetworkBodyRingBuffer.shared.freeze()
            NetworkBodyRingBuffer.shared.append(entry(ref: 2, t: 2, resBody: "pre-kill-after-freeze"))

            NetworkRingBuffer.shared.append(NetworkLogEntry(
                timestamp: Date(), method: "GET", url: "https://example.com",
                status: 200, durationMs: 1, requestHeaders: [:], responseHeaders: [:]
            ))

            Everframe.shared.kill()

            #expect(NetworkBodyRingBuffer.shared.snapshot().isEmpty)
            #expect(NetworkBodyRingBuffer.shared.takeFrozen() == nil)
            #expect(NetworkRingBuffer.shared.snapshot().isEmpty)

            // Restore shared-singleton hygiene for the rest of the suite.
            try? Everframe.shared.start(config: config)
            NetworkBodyRingBuffer.shared.clear()
            NetworkRingBuffer.shared.clear()
        }
    }

    /// Lossless decode→encode parity against the fixture shared with
    /// packages/protocol/__tests__/fixtures/network-bodies.v1.json — proves
    /// the generated `EverframeNetworkBody` shape round-trips the wire format without
    /// silently dropping/reordering/renaming fields.
    @Test func parityFixtureRoundTrips() throws {
        let url = try #require(Bundle.module.url(forResource: "network-bodies.v1", withExtension: "json"))
        let fixture = try JSONDecoder().decode([EverframeNetworkBody].self, from: Data(contentsOf: url))
        #expect(fixture.count >= 4)
        let encoder = JSONEncoder()
        let reencoded = try JSONSerialization.jsonObject(with: encoder.encode(fixture)) as! [[String: Any]]
        let original = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
        #expect(NSArray(array: reencoded) == NSArray(array: original))
    }

    // MARK: - F14: crumb↔body linkage (spec §11 test 8)

    /// Breadcrumbs disabled entirely (nil chain, mirrors "kinds omit network"
    /// / breadcrumbs off): bodies must not ship without ANY request context.
    @Test func noBreadcrumbs_bodiesPresent_networkBodiesAbsentAndNoMarker() throws {
        let builder = makeBuilder()
        let entries = [entry(ref: 1, t: 1, resBody: "a"), entry(ref: 2, t: 2, resBody: "b")]
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "everframe-ios", sdkVersion: "t",
            breadcrumbs: nil, networkBodies: entries
        )
        let json = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let payload = json["payload"] as! [String: Any]
        #expect(payload["networkBodies"] == nil)
        let cc = json["captureControl"] as! [String: Any]
        #expect(!(cc["included"] as! [String]).contains("networkBodies"))
    }

    /// `kinds` omitting `network` — only non-network crumbs shipped: same
    /// no-context outcome as no breadcrumbs at all.
    @Test func breadcrumbsWithoutNetworkKind_bodiesPresent_networkBodiesAbsent() throws {
        let builder = makeBuilder()
        let entries = [entry(ref: 1, t: 1, resBody: "a")]
        let nonNetworkCrumb = EverframeBreadcrumb(
            data: nil, kind: .console, level: .info, message: "log line", seq: 0, t: 1, truncated: nil
        )
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "everframe-ios", sdkVersion: "t",
            breadcrumbs: [nonNetworkCrumb], networkBodies: entries
        )
        let json = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let payload = json["payload"] as! [String: Any]
        #expect(payload["networkBodies"] == nil)
        let cc = json["captureControl"] as! [String: Any]
        #expect(!(cc["included"] as! [String]).contains("networkBodies"))
    }

    /// Independent eviction: 3 bodies, but only 2 network crumbs shipped
    /// (their reqIds) — the orphaned 3rd body must be dropped, not the
    /// matched pair.
    @Test func partialCrumbMatch_onlyMatchingBodiesEncode_orphanDropped() throws {
        let builder = makeBuilder()
        let entries = [
            entry(ref: 1, t: 1, resBody: "kept-1"),
            entry(ref: 2, t: 2, resBody: "kept-2"),
            entry(ref: 3, t: 3, resBody: "orphan-3"),
        ]
        let crumbs = [networkCrumb(reqId: 1, seq: 0), networkCrumb(reqId: 2, seq: 1)]
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "everframe-ios", sdkVersion: "t",
            breadcrumbs: crumbs, networkBodies: entries
        )
        let json = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
        let payload = json["payload"] as! [String: Any]
        let shippedBodies = payload["networkBodies"] as! [[String: Any]]
        #expect(shippedBodies.count == 2)
        let shippedRefs = Set(shippedBodies.map { $0["ref"] as! Double })
        #expect(shippedRefs == [1, 2])
        let cc = json["captureControl"] as! [String: Any]
        #expect((cc["included"] as! [String]).contains("networkBodies"))
    }

    /// Happy path (guard against over-filtering): every body has a matching
    /// crumb → all bodies encode, and every shipped `ref` matches exactly
    /// one shipped network crumb's `data.reqId` — the invariant itself.
    @Test func everyBodyMatched_allEncode_andInvariantHolds() throws {
        let builder = makeBuilder()
        let entries = [
            entry(ref: 10, t: 1, resBody: "a"),
            entry(ref: 20, t: 2, resBody: "b"),
            entry(ref: 30, t: 3, resBody: "c"),
        ]
        let crumbs = [
            networkCrumb(reqId: 10, seq: 0), networkCrumb(reqId: 20, seq: 1), networkCrumb(reqId: 30, seq: 2),
        ]
        let (bytes, _) = try builder.buildEncoded(
            reportId: UUID(), sdkName: "everframe-ios", sdkVersion: "t",
            breadcrumbs: crumbs, networkBodies: entries
        )
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let envelope = try decoder.decode(EverframeReportEnvelope.self, from: bytes)
        let shippedBodies = try #require(envelope.payload.networkBodies)
        #expect(shippedBodies.count == 3)
        #expect(envelope.captureControl.included.contains("networkBodies"))

        // Invariant: every shipped ref matches EXACTLY ONE shipped network
        // crumb's data.reqId.
        let shippedNetworkReqIds: [Int64] = envelope.payload.breadcrumbs?
            .filter { (b: EverframeBreadcrumb) in b.kind == .network }
            .compactMap { $0.data?["reqId"]?.value as? Int64 } ?? []
        for body in shippedBodies {
            let matches = shippedNetworkReqIds.filter { Double($0) == body.ref }
            #expect(matches.count == 1, "ref \(body.ref) must match exactly one shipped network crumb reqId")
        }
    }
}
