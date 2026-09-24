// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-i — the config read carries the derived install
// identifier as a query parameter, and, the load-bearing case, a failure
// anywhere in producing it must never break the config read itself. That
// endpoint is this Everframe SDK's remote kill switch: an uncounted install is
// cosmetic, a config fetch that never fires is not.
//
// The supplier is evaluated PER FETCH rather than baked into the stored URL,
// which is what lets Plan 2b-ii add a daily gate behind it without touching
// this signature again.
import XCTest
@testable import EverframeKit

private final class RecordingFetcher: URLSessionFetching, @unchecked Sendable {
    private let lock = NSLock()
    private var _urls: [URL] = []
    var urls: [URL] { lock.lock(); defer { lock.unlock() }; return _urls }

    /// Synchronous so the async `data(for:)` below never touches `NSLock`
    /// directly (unavailable from async contexts).
    private func record(_ url: URL) {
        lock.lock(); defer { lock.unlock() }
        _urls.append(url)
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        record(request.url!)
        let body = Data(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1}"#.utf8)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (body, response)
    }
}

final class ConfigInstallIdTests: XCTestCase {
    private let base = URL(string: "https://ingest.example.test")!

    func test_the_request_url_carries_the_install_id_query_parameter() async {
        let fetcher = RecordingFetcher()
        let provider = ReplayConfigProvider.make(
            baseURL: base, apiKey: "k", fetcher: fetcher,
            installIdProvider: { "iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA" }
        )
        _ = await provider.refresh()
        let items = URLComponents(url: fetcher.urls.first!, resolvingAgainstBaseURL: false)!.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "installId" })?.value,
                       "iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA")
        XCTAssertEqual(fetcher.urls.first!.path, "/api/config")
    }

    func test_a_nil_supplier_result_leaves_the_url_untouched() async {
        let fetcher = RecordingFetcher()
        let provider = ReplayConfigProvider.make(
            baseURL: base, apiKey: "k", fetcher: fetcher, installIdProvider: { nil }
        )
        _ = await provider.refresh()
        XCTAssertEqual(fetcher.urls.first!.absoluteString, "https://ingest.example.test/api/config")
    }

    func test_an_empty_supplier_result_leaves_the_url_untouched() async {
        let fetcher = RecordingFetcher()
        let provider = ReplayConfigProvider.make(
            baseURL: base, apiKey: "k", fetcher: fetcher, installIdProvider: { "" }
        )
        _ = await provider.refresh()
        XCTAssertEqual(fetcher.urls.first!.absoluteString, "https://ingest.example.test/api/config")
    }

    func test_the_default_supplier_sends_nothing_so_existing_call_sites_are_unchanged() async {
        let fetcher = RecordingFetcher()
        let provider = ReplayConfigProvider.make(baseURL: base, apiKey: "k", fetcher: fetcher)
        _ = await provider.refresh()
        XCTAssertFalse(fetcher.urls.first!.absoluteString.contains("installId"))
    }

    func test_the_supplier_is_evaluated_on_every_fetch_not_once() async {
        // Plan 2b-ii puts a per-UTC-day gate behind this supplier. If the
        // value were resolved once and stored, that gate could never take
        // effect — which is exactly how the web Everframe SDK shipped in 2a, and why it
        // needs a retrofit.
        let fetcher = RecordingFetcher()
        let counter = Counter()
        let provider = ReplayConfigProvider(
            configUrl: ReplayConfigProvider.configURL(from: base),
            apiKey: "k", fetcher: fetcher,
            installIdProvider: { counter.next() }
        )
        _ = await provider.refresh()
        _ = await provider.refresh(force: true)
        XCTAssertEqual(fetcher.urls.count, 2)
        XCTAssertNotEqual(fetcher.urls[0].absoluteString, fetcher.urls[1].absoluteString)
    }

    func test_a_value_needing_percent_encoding_still_produces_a_usable_url() async {
        // The kill-switch invariant, in the form Swift can actually express: a
        // `() -> String?` cannot throw, so the failure mode to guard here is a
        // value that would corrupt the URL under naive string concatenation.
        // `refresh()` must still reach the network and report success.
        let fetcher = RecordingFetcher()
        let provider = ReplayConfigProvider.make(
            baseURL: base, apiKey: "k", fetcher: fetcher,
            installIdProvider: { "a b&c=d#e" }
        )
        let ok = await provider.refresh()
        XCTAssertTrue(ok)
        XCTAssertEqual(fetcher.urls.count, 1)
        XCTAssertEqual(fetcher.urls[0].path, "/api/config")
        let items = URLComponents(url: fetcher.urls[0], resolvingAgainstBaseURL: false)!.queryItems ?? []
        XCTAssertEqual(items.first(where: { $0.name == "installId" })?.value, "a b&c=d#e")
    }

    // Fix round 2 (Important finding, plan-mandated) — a SOURCE GATE, not a
    // behavioural test, for `Everframe.swift`'s `start()` call site. No
    // behavioural test can reach `Everframe.swift:1070`'s
    // `session = ReplaySession(...)` construction: every suite that drives
    // `start()` (`KillSwitchTests`, `ReplaySessionSupersessionTests`, etc.)
    // does so through `Everframe.__replaySessionFactoryForTesting`, which
    // REPLACES that exact line with a test double — so exercising `start()`
    // proves nothing about the real argument list at the real call site.
    // This pins TEXT, not EFFECT (mirrors `ReporterOpenIdentityWarmSourceGate`
    // / `EFReporterPresenterBrandingSourceGate`): it fails if a future edit
    // drops `installIdProvider:` from that construction, even though no
    // runtime test on this host could ever observe that regression.
    private static func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // EverframeTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
    }

    private static func source(_ relativePath: String) throws -> String {
        try String(contentsOf: packageRoot().appendingPathComponent(relativePath), encoding: .utf8)
    }

    private static func strippingLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let slashes = line.range(of: "//") else { return line }
                return line[line.startIndex..<slashes.lowerBound]
            }
            .joined(separator: "\n")
    }

    func test_start_constructs_the_replay_session_with_the_install_id_provider_argument() throws {
        let code = Self.strippingLineComments(
            try Self.source("Sources/Everframe/Everframe.swift"))

        let callSite = try XCTUnwrap(
            code.range(of: "session = ReplaySession("),
            """
            Everframe.swift no longer constructs ReplaySession at its documented start() \
            call site — has it been restructured? (This gate exists because \
            __replaySessionFactoryForTesting replaces this exact line for every \
            behavioural start()/kill() suite, so nothing else can catch its argument list \
            regressing.)
            """
        )
        let argument = try XCTUnwrap(
            // Plan 2b-ii replaced the 2b-i constant (`{ installId }`) with the
            // real per-fetch, per-UTC-day supplier built by
            // `InstallIdentifier.makeSupplier`; this gate's literal moves with
            // it so the regression it guards against stays the real one.
            code.range(of: "installIdProvider: installIdProvider"),
            """
            Everframe.swift's start() no longer passes installIdProvider: installIdProvider to \
            the ReplaySession it constructs. Without this argument the MAI install \
            identifier is silently dropped at the Everframe SDK's own start() call site — the \
            provider/init wiring under it can be entirely correct while this path stays \
            genuinely dead.
            """
        )
        XCTAssertTrue(
            argument.lowerBound > callSite.lowerBound
                && code.distance(from: callSite.lowerBound, to: argument.lowerBound) < 600,
            "installIdProvider: installIdProvider was found, but not as an argument of the " +
            "ReplaySession(...) construction at start()'s call site — has a second, " +
            "unrelated occurrence been introduced elsewhere in this file?"
        )
    }

    // Companion to the gate above. That one proves the SUPPLIER reaches
    // ReplaySession; this one proves the CONFIG FLAG reaches the supplier.
    // Neither implies the other: Task 4's own mutation check confirmed a
    // build with `enabled: true` hardcoded here (config.installIdentifierEnabled
    // dropped) still passes the gate above unchanged, because that gate only
    // checks the argument NAME at the ReplaySession(...) call site, not what
    // feeds `makeSupplier` above it.
    //
    // This is a SOURCE gate, not a behavioural one, for the same reason as
    // the gate above: `start()`'s `#if canImport(UIKit)` body — and the
    // MainActor hop inside it — is unreachable from a plain `swift test` unit
    // test on this host, so there is no way to actually start() the Everframe SDK with
    // installIdentifierEnabled: false here and observe the resulting fetch.
    // It pins TEXT, not EFFECT: passing this proves the flag is wired to the
    // call site, not that the wiring behaves correctly end to end (that is
    // `InstallIdentifierDailyTests`'s job for `makeSupplier` itself, and the
    // `xcodebuild` simulator job's job for anything requiring UIKit).
    //
    // The stakes: the install identifier is a CLIENT VETO
    // (`EverframeConfig.installIdentifierEnabled`) — a host that has
    // explicitly turned it off must never have it silently re-enabled by a
    // refactor at this call site. Without this gate, that exact regression
    // (a hardcoded `enabled: true`) passes every other test in this suite.
    func test_start_feeds_the_config_flag_into_the_install_id_supplier() throws {
        let code = Self.strippingLineComments(
            try Self.source("Sources/Everframe/Everframe.swift"))

        let callSite = try XCTUnwrap(
            code.range(of: "InstallIdentifier.makeSupplier("),
            """
            Everframe.swift no longer builds the install-id supplier via \
            InstallIdentifier.makeSupplier(...) in start() — has it been restructured? \
            (This gate exists because nothing else pins WHERE the config flag must be read.)
            """
        )
        let argument = try XCTUnwrap(
            code.range(of: "enabled: config.installIdentifierEnabled"),
            """
            Everframe.swift's start() no longer passes \
            enabled: config.installIdentifierEnabled to InstallIdentifier.makeSupplier(...). \
            installIdentifierEnabled is a CLIENT VETO: a host that turned it off would have \
            the identifier silently re-enabled by whatever replaced this — e.g. a hardcoded \
            `enabled: true` — and every other test in this suite would keep passing, because \
            they only check that A supplier reaches ReplaySession, not that the CONFIG FLAG \
            feeds it.
            """
        )
        XCTAssertTrue(
            argument.lowerBound > callSite.lowerBound
                && code.distance(from: callSite.lowerBound, to: argument.lowerBound) < 200,
            "enabled: config.installIdentifierEnabled was found, but not as an argument of " +
            "the InstallIdentifier.makeSupplier(...) call in start() — has a second, " +
            "unrelated occurrence been introduced elsewhere in this file?"
        )
    }
}

/// Returns a different well-formed identifier per call, so the test can tell
/// "evaluated once" from "evaluated per fetch" by comparing recorded URLs.
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> String {
        lock.lock(); defer { lock.unlock() }
        n += 1
        return InstallIdentifier.derive(seed: Data([UInt8(n)]))
    }
}

// `ReplaySession` is UIKit-only (the whole class lives inside
// `#if canImport(UIKit)` in ReplaySession.swift), so the case below — unlike
// every other case in this file, which drives `ReplayConfigProvider`
// directly and stays macOS-`swift test`-runnable — needs the same gate,
// on the same grounds as `CrashDrainIdentityHeaderTests` and
// `ReplaySessionSupersessionTests`: it cannot compile under the host
// `swift test` job at all, only under the iOS-simulator `xcodebuild test` job.
#if canImport(UIKit)
extension ConfigInstallIdTests {
    func test_replay_session_threads_the_supplier_through_to_the_provider() async {
        // Guards the wiring, not the derivation: a correct InstallIdentifier
        // and a correct provider still count nothing if ReplaySession drops
        // the supplier on the floor between them.
        let fetcher = RecordingFetcher()
        // `ReplaySession` is `@MainActor`; this test method is not, so
        // constructing it crosses an actor boundary and needs `await`.
        let session = await ReplaySession(
            provider: ReplayConfigProvider.make(
                baseURL: URL(string: "https://ingest.example.test")!,
                apiKey: "k",
                fetcher: fetcher,
                installIdProvider: { "iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA" }
            ),
            locallyDisabled: false
        )
        _ = await session.refreshConfigNow()
        XCTAssertTrue(fetcher.urls.first!.absoluteString.contains(
            "installId=iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA"))
    }

    // Fix round 2 (Important finding, plan-mandated) — the case above locks
    // a PRE-EXISTING seam (`ReplaySession`'s internal
    // `init(provider:locallyDisabled:startEpoch:)`, which already accepted a
    // pre-built provider before this task touched anything). It never calls
    // either of this task's actual production changes: the public
    // convenience init `ReplaySession.init(baseURL:apiKey:locallyDisabled:
    // startEpoch:installIdProvider:)` (ReplaySession.swift:163-172) or its
    // one call site in `Everframe.swift` — so a convenience init that
    // silently dropped `installIdProvider` when forwarding to
    // `ReplayConfigProvider.make` would leave the case above green.
    //
    // This case goes through the convenience init itself. It cannot use a
    // stub fetcher — the convenience init takes no fetcher parameter, so it
    // always resolves to `URLSession.shared` — so it drives a REAL local
    // socket server (`RecordingHTTPServer`; see that type's own doc comment
    // for why a `URLProtocol` stub cannot stand in here) and inspects the
    // path Foundation actually put on the wire.
    func test_the_convenience_init_carries_the_supplier_to_a_real_request() async throws {
        let server = try RecordingHTTPServer()
        defer { server.stop() }
        server.respond = { _ in
            (200, ["Content-Type": "application/json"],
             Data(#"{"replayEnabled":false,"replayDurationSec":30,"samplingRate":1}"#.utf8))
        }

        let session = await ReplaySession(
            baseURL: server.url,
            apiKey: "k",
            locallyDisabled: false,
            startEpoch: 0,
            installIdProvider: { "iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA" }
        )
        // Only returns once the real HTTP round trip has completed, so the
        // server has already recorded the request by the time this resumes
        // — same synchronization AccountSwitchEvidenceDiscardTests relies on
        // against the same server type, no sleep/poll needed.
        _ = await session.refreshConfigNow()

        guard let recorded = server.recorded.first else {
            XCTFail("fixture sanity: the server must have received exactly one request")
            return
        }
        XCTAssertTrue(recorded.path.hasPrefix("/api/config"), "got path: \(recorded.path)")
        XCTAssertTrue(
            recorded.path.contains("installId=iYgxBgJiRf1n_ekekB7M9g03ulCzNx2O4jfL8PWLegA"),
            "got path: \(recorded.path)"
        )
    }
}
#endif
