// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Fix round 1 finding (Important 1). Of the platform's TWO production drain
// call sites, `TraceItX.start()`'s launch drain runs too early to EVER attach
// a header: `start()` clears `_identityHolder` synchronously moments before
// the launch drain reads it, and `currentReplayConfig()` resolves `.off`
// because the `ReplaySession` that would fetch a real one is installed LATER
// in that same async tail (the `#if canImport(UIKit)` MainActor block runs
// after the launch drain). That is fail-closed and safe, not a leak — but it
// means the launch drain can never be the retry path that recovers "Alice
// queues offline, Bob signs in, the retry fires": that report ships
// unattributed forever and is then deleted on 200.
//
// `CrashReporter.swift`'s non-fatal immediate drain (`Task { await
// submitter.drainOutbox(identityHolder: TraceItX.shared._identityHolder,
// currentReplayConfig: { await TraceItX.shared.currentReplayConfig() }) }`)
// is the OTHER
// call site, and it does NOT share either limitation: it runs whenever a
// still-alive app catches a non-fatal JS error, arbitrarily long after
// `start()` — by which point `_replaySession` has had a real chance to fetch,
// and the host has had a real chance to call `setIdentityToken` after
// `start()` returned.
//
// This suite proves that concretely. It cannot drive `CrashReporter
// .captureFacts(fatal: false, ...)`'s own spawned `Task` directly: that Task
// is fire-and-forget with no completion signal to await, and it constructs
// its `ReportSubmitter` with the REAL, unstubbed `makeIsolatedSession()` (no
// injection seam), so a background attempt against an unreachable host would
// either race this test's own assertions or genuinely hit the network.
// Instead: install a REAL `ReplaySession` (via `__replaySessionFactoryForTesting`)
// built from a stub fetcher that resolves identity-enabled immediately —
// standing in for "the fetch already completed" — call the real
// `TraceItX.shared.setIdentityToken(...)` the way a host would post-`start()`,
// capture a crash via the real `CrashReporter.captureFacts` (proving
// `identitySubject` actually reaches the entry), and then execute the EXACT
// statement `CrashReporter.swift`'s non-fatal Task runs — `submitter
// .drainOutbox(identityHolder: TraceItX.shared._identityHolder,
// currentReplayConfig: { await TraceItX.shared.currentReplayConfig() })` — against a
// `RecordingURLProtocol`-stubbed session, and assert the real header on the
// real (stubbed) request. Every value read (`_identityHolder`,
// `currentReplayConfig()`) is the live production accessor, not a hand-built
// fixture.
//
// UIKit-gated (not just `ReporterSubmission.swift` — `ReplaySession` itself
// only exists on UIKit platforms), so unlike `DrainIdentityHeaderTests` this
// cannot run under macOS `swift test`. Runs via `xcodebuild test` on
// `lifecycle-tests-iOS` (added to its `-only-testing:` allowlist), the same
// job `ReplaySessionSupersessionTests` uses for the identical reason.
#if canImport(UIKit)
import Testing
import Foundation
@testable import TraceItXKit

@MainActor
@Suite(.serialized)
struct CrashDrainIdentityHeaderTests {
    private let testAppId = "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"

    private func jwt(sub: String, exp: Date) -> String {
        let header = #"{"alg":"HS256","typ":"JWT"}"#.data(using: .utf8)!
        let payload = try! JSONSerialization.data(withJSONObject: ["sub": sub, "exp": Int(exp.timeIntervalSince1970)])
        func b64(_ d: Data) -> String {
            d.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return "\(b64(header)).\(b64(payload)).sig"
    }

    private func stubbedSession() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        return URLSession(configuration: cfg)
    }

    @Test func nonFatalCrashDrainAttachesTheHeaderOnceIdentityAndConfigHaveGenuinelySettled() async throws {
        try await withGlobalCaptureStateLock {
            defer { TraceItX.__resetReplaySessionFactoryForTesting() }

            // Stand in for "the ReplaySession's initial config fetch already
            // completed" — resolves identity-enabled immediately, no gate to
            // park on.
            let fetcher = ImmediateIdentityFetcher(body: Data(
                #"""
                {"replayEnabled":false,"replayDurationSec":30,"samplingRate":1.0,
                "identity":{"enabled":true}}
                """#.utf8
            ))
            let provider = ReplayConfigProvider(
                configUrl: URL(string: "https://x/api/config")!,
                apiKey: "a",
                fetcher: fetcher
            )
            // Construct after start() advances its epoch, as the production factory does.
            TraceItX.__replaySessionFactoryForTesting = { _ in
                ReplaySession(provider: provider, locallyDisabled: false)
            }

            let config = TraceItXConfig(appId: testAppId, capture: CaptureConfig(logs: false))
            try TraceItX.shared.start(config: config)

            let fetched = await AsyncTestHelpers.waitFor({ fetcher.callCount >= 1 })
            #expect(fetched, "session's initial fetch never ran — test setup is wrong, not exercising the settled-config case")
            // Give refreshConfigNow's apply (post-fetch, pre-return) time to
            // land in configBox.
            try? await Task.sleep(nanoseconds: 100_000_000)

            // Not vacuous: prove the seam CrashReporter's Task itself reads
            // really does reflect the fetch above, before relying on it.
            let liveConfig = await TraceItX.shared.currentReplayConfig()
            #expect(isIdentityEnabled(liveConfig), "fixture sanity: currentReplayConfig() must reflect the settled fetch")

            // The host calling setIdentityToken some time after start() —
            // exactly the ordering this drain site (unlike the launch drain)
            // can actually observe.
            let now = Date()
            let token = jwt(sub: "alice", exp: now.addingTimeInterval(300))
            TraceItX.shared.setIdentityToken(.token(token))

            // The RN bridge's non-fatal path, via the real captureFacts —
            // proves identitySubject actually reaches the entry too. Uses a
            // throwaway outbox so this test controls the drain step
            // precisely, rather than racing CrashReporter's own unobservable
            // fire-and-forget Task (see file header).
            let tempDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("traceitx-crash-drain-identity-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: tempDir) }
            let outbox = JSONLOutbox(testFileURL: tempDir.appendingPathComponent("outbox.jsonl"))

            let json = """
            {"exceptionType":"RangeError","message":"non-fatal boom","framesRaw":[],"mechanism":"errorutils","fatal":false,"occurredAt":"2026-08-13T00:00:00Z"}
            """
            let captured = CrashReporter.captureFacts(json: json, outbox: outbox, config: config)
            #expect(captured)

            let entries = try outbox.hydrate()
            #expect(entries.count == 1)
            #expect(entries.first?.identitySubject == "alice", "the crash entry must carry the subject captured with it")

            // THE ASSERTION: execute the exact statement CrashReporter.swift's
            // non-fatal Task runs, against a stubbed session so the real
            // request is observable.
            RecordingURLProtocol.reset()
            let submitter = ReportSubmitter(config: config, outbox: outbox, session: stubbedSession())
            // Mirrors CrashReporter.swift's own `epochAtInitiation` capture
            // (independent review, round 8, Serious 1) — synchronous, right
            // alongside `submitter` above.
            let epochAtInitiation = TraceItX.shared.currentStartEpoch
            await submitter.drainOutbox(
                identityHolder: TraceItX.shared._identityHolder,
                currentReplayConfig: { await TraceItX.shared.currentReplayConfig() },
                epochAtInitiation: epochAtInitiation,
                currentEpoch: { TraceItX.shared.currentStartEpoch }
            )

            #expect(RecordingURLProtocol.recorded.count == 1)
            #expect(
                RecordingURLProtocol.recorded.first?.identityToken == token,
                "the real requestOutboxDrain-equivalent path must attach alice's token once identity and config are live"
            )

            TraceItX.shared.kill()
        }
    }
}

/// A fetcher that resolves identity-enabled immediately — mirrors
/// `ReplaySessionSupersessionTests`' private `ImmediateFetcher`, re-declared
/// here per that file's own documented convention (not shared).
private final class ImmediateIdentityFetcher: URLSessionFetching, @unchecked Sendable {
    private let respBody: Data
    private(set) var callCount = 0

    init(body: Data) {
        self.respBody = body
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        callCount += 1
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (respBody, response)
    }
}
#endif
