// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CONFIG-02 parity — fail-closed `GET /api/config` provider, ported from
// sdk-core/src/types/replay/config-provider.ts. Every error path is driven by an
// injected `URLSessionFetching` stub + an injected clock — NO real network.
import XCTest
@testable import EverframeKit

/// A stub `URLSessionFetching` that returns a canned (Data, URLResponse) or throws.
/// Records the outbound request + a call count so TTL no-op can be asserted.
private final class StubFetcher: URLSessionFetching, @unchecked Sendable {
    enum Outcome {
        case success(status: Int, body: Data)
        case failure(Error)
    }

    /// The queue of outcomes; each call pops the next (or reuses the last if exhausted).
    var outcomes: [Outcome]
    private(set) var callCount = 0
    private(set) var lastRequest: URLRequest?

    init(_ outcomes: [Outcome]) {
        self.outcomes = outcomes
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        lastRequest = request
        let outcome = outcomes[min(callCount, outcomes.count - 1)]
        callCount += 1
        switch outcome {
        case let .success(status, body):
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: nil
            )!
            return (body, response)
        case let .failure(error):
            throw error
        }
    }
}

private struct StubTimeoutError: Error {}

/// Tiny actor gate letting a test park a fetch deterministically and release
/// it explicitly (mirrors `ReplaySessionTeardownRaceTests.swift`'s private
/// `AsyncGate` — file-private there, so re-declared here per that file's own
/// documented convention).
private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume() }
    }

    func waitUntilOpen() async {
        if isOpen { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            waiters.append(cont)
        }
    }
}

/// A fetcher whose FIRST call parks on `gateA` and whose SECOND (and later)
/// call parks on `gateB`, each returning its own canned response once
/// released — lets a test start two overlapping `refresh()` calls and
/// control exactly which one's underlying network response resolves first,
/// deterministically reproducing F32's out-of-order-completion race.
private final class TwoCallGatedFetcher: URLSessionFetching, @unchecked Sendable {
    private let gateA: AsyncGate
    private let bodyA: Data
    private let gateB: AsyncGate
    private let bodyB: Data
    private(set) var callCount = 0

    init(gateA: AsyncGate, bodyA: Data, gateB: AsyncGate, bodyB: Data) {
        self.gateA = gateA
        self.bodyA = bodyA
        self.gateB = gateB
        self.bodyB = bodyB
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        callCount += 1
        let isFirstCall = callCount == 1
        if isFirstCall {
            await gateA.waitUntilOpen()
        } else {
            await gateB.waitUntilOpen()
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (isFirstCall ? bodyA : bodyB, response)
    }
}

/// A mutable monotonic clock holder safe to capture in a `@Sendable` closure.
private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval
    init(_ value: TimeInterval = 0) { self.value = value }
    func set(_ v: TimeInterval) { lock.lock(); value = v; lock.unlock() }
    var read: TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
}

final class ReplayConfigProviderTests: XCTestCase {

    private let configUrl = URL(string: "https://everframe.dev/api/config")!
    private let apiKey = "evr_test_key"

    private func makeProvider(
        _ fetcher: URLSessionFetching,
        clock: @escaping @Sendable () -> TimeInterval = { 0 }
    ) -> ReplayConfigProvider {
        ReplayConfigProvider(
            configUrl: configUrl,
            apiKey: apiKey,
            fetcher: fetcher,
            now: clock
        )
    }

    private func body(_ json: String) -> Data { Data(json.utf8) }

    /// Fetch-and-decode shorthand shared by the branding tests below (and
    /// usable anywhere else a test just needs the decoded `ReplayConfig` for
    /// a canned 200 body) — mirrors the companionBadge tests'
    /// fetch-then-`provider.current` pattern one-for-one.
    private func decodedConfig(json: String) async -> ReplayConfig {
        let fetcher = StubFetcher([.success(status: 200, body: body(json))])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        return await provider.current
    }

    // MARK: - default OFF

    func testDefaultOff() async {
        let provider = makeProvider(StubFetcher([.success(status: 200, body: body("{}"))]))
        let current = await provider.current
        XCTAssertFalse(current.replayEnabled)
        XCTAssertEqual(current.replayDurationSec, 30)
        XCTAssertEqual(current.samplingRate, 1.0)
    }

    // MARK: - valid 200 flips ON

    func testValid200FlipsOn() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled)
        XCTAssertEqual(c.replayDurationSec, 15)
        XCTAssertEqual(c.samplingRate, 0.5, accuracy: 1e-9)
    }

    func testRequestCarriesBearerAndAccept() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let req = fetcher.lastRequest
        XCTAssertEqual(req?.url, configUrl)
        XCTAssertEqual(req?.httpMethod, "GET")
        XCTAssertEqual(req?.value(forHTTPHeaderField: "Authorization"), "Bearer \(apiKey)")
        XCTAssertEqual(req?.value(forHTTPHeaderField: "Accept"), "application/json")
    }

    // MARK: - fail closed: non-200

    func testNon200FailsClosed() async {
        let fetcher = StubFetcher([.success(status: 500, body: body("internal error"))])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertFalse(c.replayEnabled)
    }

    // MARK: - fail closed: malformed body

    func testMalformedBodyFailsClosed() async {
        let fetcher = StubFetcher([.success(status: 200, body: body("not json at all"))])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertFalse(c.replayEnabled)
    }

    func testMissingFieldFailsClosed() async {
        // Missing samplingRate.
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertFalse(c.replayEnabled)
    }

    func testWrongTypeFailsClosed() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":"yes","replayDurationSec":15,"samplingRate":0.5}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertFalse(c.replayEnabled)
    }

    // MARK: - fail closed: out-of-range samplingRate

    func testOutOfRangeSamplingRateFailsClosed() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":2.0}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        // A hostile rate never reaches the gate — cache stays OFF (clamp NOT acceptable).
        let c = await provider.current
        XCTAssertFalse(c.replayEnabled)
        XCTAssertEqual(c.samplingRate, 1.0)
    }

    func testNegativeSamplingRateFailsClosed() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":-0.1}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertFalse(c.replayEnabled)
    }

    // MARK: - fail closed: timeout / thrown error

    func testTimeoutFailsClosed() async {
        let fetcher = StubFetcher([.failure(StubTimeoutError())])
        let provider = makeProvider(fetcher)
        await provider.refresh()  // must not throw
        let c = await provider.current
        XCTAssertFalse(c.replayEnabled)
    }

    // MARK: - last-good retained across a transient error

    func testLastGoodRetainedAcrossError() async {
        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}"#)),
            .failure(StubTimeoutError()),
        ])
        let provider = makeProvider(fetcher, clock: { clock.read })
        await provider.refresh()
        let afterGood = await provider.current
        XCTAssertTrue(afterGood.replayEnabled)
        // Advance past TTL so the second refresh actually fetches (and fails).
        clock.set(600)  // 10 min > 5 min TTL
        await provider.refresh()
        // An error never flips ON → OFF mid-session.
        let afterError = await provider.current
        XCTAssertTrue(afterError.replayEnabled)
        XCTAssertEqual(fetcher.callCount, 2)
    }

    // MARK: - breadcrumbs block

    func testConfigBodyWithBreadcrumbsBlockDecodesAndSurfacesIt() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "breadcrumbs":{"enabled":true,"kinds":["navigation","error"],"maxCount":50,
                "byteBudget":8192,"consoleEntryCap":512}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertEqual(c.breadcrumbs?.maxCount, 50)
        XCTAssertEqual(c.breadcrumbs?.kinds, ["navigation", "error"])
    }

    // Pins iOS's already-tolerant keyed decoding: an extra unknown field INSIDE the
    // breadcrumbs block does not fail the decode (Swift's `Decodable` keyed
    // containers ignore unrequested keys by default) — no source change needed here,
    // unlike Android's strict `Json { ignoreUnknownKeys = false }` which required a
    // lenient surrogate serializer (see ReplayConfigProvider.kt).
    func testUnknownFieldInsideBreadcrumbsBlockDoesNotFailClose() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "breadcrumbs":{"enabled":true,"kinds":["tap"],"maxCount":50,
                "byteBudget":8192,"consoleEntryCap":512,"futureField":"ignored"}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled)
        XCTAssertEqual(c.breadcrumbs?.maxCount, 50)
    }

    func testLegacyThreeFieldBodyStillDecodesWithNilBreadcrumbs() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertNil(c.breadcrumbs)
    }

    func testRetiredImageCapabilityIsNotAdvertised() {
        XCTAssertFalse(ReplayConfigProvider.sdkFeaturesHeaderValue.contains("replayimages"))
    }

    // MARK: - companionBadge block (dashboard config plan 2026-08-25)
    //
    // `position` stays a raw String on the wire — resolution to
    // `CompanionBadgePosition` happens at the badge (`CompanionBadgeResolution`),
    // so an unrecognised future position degrades gracefully there rather than
    // here. See `CompanionBadgeConfigWire`'s own doc comment.

    func testDecodesCompanionBadgeBlock() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "companionBadge":{"enabled":false,"position":"top-left"}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertEqual(c.companionBadge, CompanionBadgeConfigWire(enabled: false, position: "top-left"))
    }

    func testCompanionBadgeAbsentDecodesToNil() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertNil(c.companionBadge)
    }

    func testMalformedCompanionBadgeDegradesToNilNotWholeParse() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "companionBadge":{"enabled":"yes"}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled, "a malformed companionBadge block must not sink the whole config decode")
        XCTAssertNil(c.companionBadge)
    }

    func testFeaturesHeaderAdvertisesCompanionBadge() {
        XCTAssertTrue(ReplayConfigProvider.sdkFeaturesHeaderValue.contains("companionbadge"))
    }

    // MARK: - resources block (Report EverframeResource Window, spec 2026-09-05)
    //
    // The server emits this block ONLY to a caller that declares `resources`
    // in X-Everframe-SDK-Features — without the token below the feature is
    // silently, permanently off (the negotiation gap this Everframe SDK closes).

    func testDecodesResourcesBlock() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "resources":{"enabled":true,"windowSec":120}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertEqual(c.resources, ResourcesConfigWire(enabled: true, windowSec: 120))
    }

    func testResourcesAbsentDecodesToNil() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertNil(c.resources)
    }

    func testMalformedResourcesEnabledDegradesWholeBlockToNilNotWholeParse() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "resources":{"enabled":"yes","windowSec":120}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled, "a malformed resources block must not sink the whole config decode")
        XCTAssertNil(c.resources)
    }

    // A malformed/non-positive windowSec degrades ONLY that field — `enabled`
    // must still come through, so the Everframe SDK knows the feature is on and falls
    // back to `ResourceRingBuffer.defaultWindowSec` rather than losing the
    // whole block over one bad number.
    func testMalformedWindowSecDegradesToNilWithoutLosingEnabled() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "resources":{"enabled":true,"windowSec":-5}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertEqual(c.resources?.enabled, true)
        XCTAssertNil(c.resources?.windowSec)
    }

    func testFeaturesHeaderAdvertisesResources() {
        XCTAssertTrue(ReplayConfigProvider.sdkFeaturesHeaderValue.contains("resources"))
    }

    // Session Vitals never shipped on iOS — this Everframe SDK must not advertise a
    // `vitals` token (there is no vitals-decode code path here to gate it).
    // MARK: - networkBodies block

    func testDecodesNetworkBodiesBlock() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true,"bodyByteCap":4096,
                "bodyContentTypes":["application/json"],"bodyTotalBudget":131072}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertEqual(c.networkBodies?.captureBodies, true)
        XCTAssertEqual(c.networkBodies?.bodyByteCap, 4096)
        XCTAssertEqual(c.networkBodies?.bodyContentTypes, ["application/json"])
        XCTAssertEqual(c.networkBodies?.bodyTotalBudget, 131072)
    }

    func testMalformedNetworkBodiesBlockDegradesToNilNotFailure() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":"yes"}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        // Whole decode survived even though the nested block was malformed.
        XCTAssertTrue(c.replayEnabled)
        XCTAssertEqual(c.replayDurationSec, 30)
        XCTAssertEqual(c.samplingRate, 1.0, accuracy: 1e-9)
        // The block degraded to absent rather than sinking the decode.
        XCTAssertNil(c.networkBodies)
    }

    func testMissingNetworkBodiesBlockDecodesAsNil() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertNil(c.networkBodies)
    }

    // MARK: - networkBodies block wire-limit validation (round-2 review Finding F10)
    //
    // Mirrors the server's NetworkBodiesBlockSchema ceilings
    // (the server configuration contract): bodyByteCap 1...65536,
    // bodyTotalBudget 1...1_048_576, bodyContentTypes (when present) 1...16
    // entries of 1...64 chars each. An out-of-range value must degrade the
    // WHOLE networkBodies block to nil (fail closed) via the existing
    // `try? decodeIfPresent` in ReplayConfigWire.init(from:), while the
    // top-level config (replayEnabled/replayDurationSec/samplingRate) still
    // decodes successfully. Without this, `bodyByteCap: Int.max` would
    // later overflow `cap + secretScanOverlap` in NetworkBodyCapture and
    // TRAP the host process; a negative cap corrupts the truncation-window
    // math.

    private func networkBodiesBody(bodyByteCap: String) -> Data {
        body(
            #"""
            {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true,"bodyByteCap":\#(bodyByteCap)}}
            """#
        )
    }

    func testBodyByteCapAtCeilingDecodesOk() async {
        let fetcher = StubFetcher([.success(status: 200, body: networkBodiesBody(bodyByteCap: "65536"))])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled)
        XCTAssertEqual(c.networkBodies?.bodyByteCap, 65536)
    }

    func testBodyByteCapOneOverCeilingDegradesBlockToNil() async {
        let fetcher = StubFetcher([.success(status: 200, body: networkBodiesBody(bodyByteCap: "65537"))])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        // Top-level config still decodes.
        XCTAssertTrue(c.replayEnabled)
        XCTAssertEqual(c.replayDurationSec, 30)
        // The block degraded to absent.
        XCTAssertNil(c.networkBodies)
    }

    func testBodyByteCapZeroDegradesBlockToNil() async {
        let fetcher = StubFetcher([.success(status: 200, body: networkBodiesBody(bodyByteCap: "0"))])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled)
        XCTAssertNil(c.networkBodies)
    }

    func testBodyByteCapNegativeDegradesBlockToNil() async {
        let fetcher = StubFetcher([.success(status: 200, body: networkBodiesBody(bodyByteCap: "-1"))])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled)
        XCTAssertNil(c.networkBodies)
    }

    func testBodyByteCapIntMaxDegradesBlockToNilRatherThanTrappingLater() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: networkBodiesBody(bodyByteCap: "\(Int.max)")),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled)
        XCTAssertNil(c.networkBodies)
    }

    func testBodyTotalBudgetAtCeilingDecodesOk() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true,"bodyTotalBudget":1048576}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertEqual(c.networkBodies?.bodyTotalBudget, 1_048_576)
    }

    func testBodyTotalBudgetOneOverCeilingDegradesBlockToNil() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true,"bodyTotalBudget":1048577}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled)
        XCTAssertNil(c.networkBodies)
    }

    func testBodyTotalBudgetZeroDegradesBlockToNil() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true,"bodyTotalBudget":0}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertNil(c.networkBodies)
    }

    func testEmptyBodyContentTypesArrayDegradesBlockToNil() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true,"bodyContentTypes":[]}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertTrue(c.replayEnabled)
        XCTAssertNil(c.networkBodies)
    }

    func testSeventeenBodyContentTypesDegradesBlockToNil() async {
        let types = (1...17).map { #""t\#($0)""# }.joined(separator: ",")
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true,"bodyContentTypes":[\#(types)]}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertNil(c.networkBodies)
    }

    func testSixteenBodyContentTypesDecodesOk() async {
        let types = (1...16).map { #""t\#($0)""# }.joined(separator: ",")
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true,"bodyContentTypes":[\#(types)]}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertEqual(c.networkBodies?.bodyContentTypes?.count, 16)
    }

    func testOverlongBodyContentTypeEntryDegradesBlockToNil() async {
        let tooLong = String(repeating: "x", count: 65)
        let fetcher = StubFetcher([
            .success(status: 200, body: body(
                #"""
                {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
                "networkBodies":{"captureBodies":true,"bodyContentTypes":["\#(tooLong)"]}}
                """#
            )),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let c = await provider.current
        XCTAssertNil(c.networkBodies)
    }

    func testRefreshDeclaresNetworkBodiesCapability() async {
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}"#)),
        ])
        let provider = makeProvider(fetcher)
        await provider.refresh()
        let req = fetcher.lastRequest
        // Widened to also declare `identity` (native identity Task 2) —
        // see IdentityConfigGateTests.testTheConfigRequestDeclaresTheIdentityCapability
        // for the regression guard on that specific token — `companionBadge`,
        // `resources` (Report EverframeResource Window, spec 2026-09-05),
        // and `vitals` (Session Vitals iOS spec 2026-09-05 §1).
        // Exact-string on purpose: the server emits a block ONLY to
        // callers that declare it, so this header is the whole reason any of
        // these blocks arrive, and widening it should have to be deliberate.
        XCTAssertEqual(
            req?.value(forHTTPHeaderField: "X-Everframe-SDK-Features"),
            "networkbodies, identity, companionbadge, branding, nativevideo, vitals, resources, shaketoreport"
        )
    }

    // MARK: - branding block (iOS spec 2026-08-26)
    // Field-level leniency: a bad color degrades THAT FIELD alone; the
    // watermark entitlement signal survives any theme damage; nothing in
    // this block can ever sink the whole config decode.

    func testDecodesBrandingBlockWithTheme() async {
        let c = await decodedConfig(json: """
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
             "branding":{"watermark":false,"theme":{"accent":"#336699","background":"#101215"}}}
            """)
        XCTAssertEqual(
            c.branding,
            BrandingConfigWire(watermark: false, theme: BrandingThemeWire(background: "#101215", accent: "#336699"))
        )
    }

    func testAbsentBrandingDecodesToNil() async {
        let c = await decodedConfig(json: """
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0}
            """)
        XCTAssertNil(c.branding)
    }

    func testFreePlanWatermarkOnly() async {
        let c = await decodedConfig(json: """
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
             "branding":{"watermark":true}}
            """)
        XCTAssertEqual(c.branding, BrandingConfigWire(watermark: true, theme: nil))
    }

    func testStringTypedWatermarkIsRejectedNotCoerced() async {
        // Android needed an explicit isString guard (f4d9d3c7); Swift's
        // type-strict Bool decode gives the same posture for free — lock it.
        let c = await decodedConfig(json: """
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
             "branding":{"watermark":"false","theme":{"accent":"#336699"}}}
            """)
        XCTAssertNil(c.branding?.watermark)
        XCTAssertEqual(c.branding?.theme?.accent, "#336699")
    }

    func testOneBadHexDegradesAloneWatermarkAndSiblingsSurvive() async {
        let c = await decodedConfig(json: """
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
             "branding":{"watermark":false,"theme":{"accent":"red","background":"#101215"}}}
            """)
        XCTAssertEqual(c.branding?.watermark, false)
        XCTAssertNil(c.branding?.theme?.accent)
        XCTAssertEqual(c.branding?.theme?.background, "#101215")
    }

    func testNonObjectThemeDegradesToNilWatermarkSurvives() async {
        let c = await decodedConfig(json: """
            {"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5,
             "branding":{"watermark":false,"theme":"dark"}}
            """)
        XCTAssertTrue(c.replayEnabled, "a malformed branding sub-object must not sink the whole config decode")
        XCTAssertEqual(c.branding?.watermark, false)
        XCTAssertNil(c.branding?.theme)
    }

    func testBrandingToleratesUnknownNestedFields() async {
        let c = await decodedConfig(json: """
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
             "branding":{"watermark":false,"future":1,"theme":{"accent":"#336699","futureRole":"#000000"}}}
            """)
        XCTAssertEqual(c.branding?.watermark, false)
        XCTAssertEqual(c.branding?.theme?.accent, "#336699")
    }

    func testTrailingNewlineHexIsRejected() async {
        // ICU regex '$' would have accepted this — the character-class gate must not.
        let c = await decodedConfig(json: """
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
             "branding":{"watermark":false,"theme":{"accent":"#336699\\n","background":"#101215"}}}
            """)
        XCTAssertEqual(c.branding?.watermark, false)
        XCTAssertNil(c.branding?.theme?.accent)
        XCTAssertEqual(c.branding?.theme?.background, "#101215")
    }

    // MARK: - Final-review Finding 4 (polling at TTL doubles latency) / Finding 5 (failed refresh must fail closed)

    /// `refresh(force: true)` bypasses the TTL gate entirely — two
    /// back-to-back forced calls, even with no clock advance, both actually
    /// fetch. This is what lets `ReplaySession`'s periodic loop re-read on
    /// every wake instead of racing its own TTL and effectively halving its
    /// own polling rate (the loop sleeps exactly one TTL, so an unforced
    /// `refresh()` at each wake was always just-under-TTL and a no-op).
    func testForceBypassesTtlSoTwoBackToBackForcedCallsBothFetch() async {
        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}"#)),
        ])
        let provider = makeProvider(fetcher, clock: { clock.read })
        _ = await provider.refresh(force: true)
        XCTAssertEqual(fetcher.callCount, 1)
        // No clock advance at all — an unforced refresh() would no-op here.
        _ = await provider.refresh(force: true)
        XCTAssertEqual(fetcher.callCount, 2)
    }

    /// `refresh(force:)` reports whether THIS attempt succeeded, distinct
    /// from the cache's last-good value: a forced fetch that fails (network
    /// error, non-200, decode failure) returns `false` even though the cache
    /// silently keeps its last-good contents. This is the signal
    /// `ReplaySession.refreshConfigNow()` uses to fail the network-body gate
    /// closed rather than trusting a config it could not actually confirm is
    /// still current (Finding 5).
    func testForceRefreshReturnsFalseOnFailureAndTrueOnSuccess() async {
        let fetcher = StubFetcher([
            .failure(StubTimeoutError()),
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}"#)),
        ])
        let provider = makeProvider(fetcher)
        let firstResult = await provider.refresh(force: true)
        XCTAssertFalse(firstResult)
        let secondResult = await provider.refresh(force: true)
        XCTAssertTrue(secondResult)
    }

    func testNonForcedRefreshReturnsTrueOnTtlSkip() async {
        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}"#)),
        ])
        let provider = makeProvider(fetcher, clock: { clock.read })
        let firstResult = await provider.refresh()
        XCTAssertTrue(firstResult)
        // Within TTL — no fetch, but the cache is fresh, so this still
        // reports success (per Finding 5's contract: "TTL-skip with fresh
        // cache on the non-forced path" counts as true).
        let secondResult = await provider.refresh()
        XCTAssertTrue(secondResult)
        XCTAssertEqual(fetcher.callCount, 1)
    }

    // MARK: - TTL no-op

    func testTtlNoOpWithinWindow() async {
        let clock = MutableClock(0)
        let fetcher = StubFetcher([
            .success(status: 200, body: body(#"{"replayEnabled":true,"replayDurationSec":15,"samplingRate":0.5}"#)),
        ])
        let provider = makeProvider(fetcher, clock: { clock.read })
        await provider.refresh()
        XCTAssertEqual(fetcher.callCount, 1)
        // Within the 5-min TTL — no second fetch.
        clock.set(60)  // 1 min
        await provider.refresh()
        XCTAssertEqual(fetcher.callCount, 1)
        // After TTL — refetches.
        clock.set(301)  // > 5 min
        await provider.refresh()
        XCTAssertEqual(fetcher.callCount, 2)
    }

    // MARK: - F32 (round-7 review, P1): overlapping refreshes commit in START order

    /// `actor` isolation serializes each method's synchronous stretches but
    /// NOT completion order across suspension points — two overlapping
    /// `refresh()` calls used to let whichever resolved LAST simply
    /// overwrite `cache`. This is the reviewer's exact probe: request A
    /// (ON) starts first, request B (OFF) starts second, B resolves first,
    /// A resolves last — the cache must end up B's OFF, and A's own call
    /// must report `false` (not a fresh success) so a caller like
    /// `ReplaySession.refreshConfigNow()` never mistakes it for a
    /// confirmed-current read.
    func testOlderStartedRequestNeverOverwritesNewerOneEvenResolvingLast() async {
        let gateA = AsyncGate()
        let gateB = AsyncGate()
        let onBody = body(
            #"""
            {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#
        )
        let offBody = body(
            #"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":false}}
            """#
        )
        let fetcher = TwoCallGatedFetcher(gateA: gateA, bodyA: onBody, gateB: gateB, bodyB: offBody)
        let provider = makeProvider(fetcher)

        // Start request A (ON) first.
        let taskA = Task { await provider.refresh(force: true) }
        let aStarted = await AsyncTestHelpers.waitFor({ fetcher.callCount >= 1 })
        XCTAssertTrue(aStarted, "request A never started — test setup is wrong, not exercising the race")

        // Start request B (OFF) after A has already started (but before A resolves).
        let taskB = Task { await provider.refresh(force: true) }
        let bStarted = await AsyncTestHelpers.waitFor({ fetcher.callCount >= 2 })
        XCTAssertTrue(bStarted, "request B never started — test setup is wrong, not exercising the race")

        // Resolve B (the NEWER request) first.
        await gateB.open()
        let bSucceeded = await taskB.value
        XCTAssertTrue(bSucceeded)

        // THEN resolve A (the OLDER request) — it must NOT win despite
        // resolving last.
        await gateA.open()
        let aSucceeded = await taskA.value
        XCTAssertFalse(aSucceeded, "a superseded response must not report success")

        let c = await provider.current
        XCTAssertFalse(c.replayEnabled, "B's newer OFF result must win even though A resolved last")
        XCTAssertEqual(c.networkBodies?.captureBodies, false)
    }

    /// The ordinary (non-adversarial) overlap case: completion order happens
    /// to match start order. Must still behave correctly — this pins that
    /// the fix doesn't accidentally penalize the common case.
    func testOverlappingRequestsResolvingInStartOrderStillCommitTheNewerOne() async {
        let gateA = AsyncGate()
        let gateB = AsyncGate()
        let onBody = body(
            #"""
            {"replayEnabled":true,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":true}}
            """#
        )
        let offBody = body(
            #"""
            {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
            "networkBodies":{"captureBodies":false}}
            """#
        )
        let fetcher = TwoCallGatedFetcher(gateA: gateA, bodyA: onBody, gateB: gateB, bodyB: offBody)
        let provider = makeProvider(fetcher)

        let taskA = Task { await provider.refresh(force: true) }
        _ = await AsyncTestHelpers.waitFor({ fetcher.callCount >= 1 })
        let taskB = Task { await provider.refresh(force: true) }
        _ = await AsyncTestHelpers.waitFor({ fetcher.callCount >= 2 })

        // Resolve A first this time — completion order == start order.
        await gateA.open()
        _ = await taskA.value

        await gateB.open()
        let bSucceeded = await taskB.value
        XCTAssertTrue(bSucceeded)

        let c = await provider.current
        XCTAssertFalse(c.replayEnabled)
        XCTAssertEqual(c.networkBodies?.captureBodies, false)
    }
}
