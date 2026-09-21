// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Orchestrates the submit pipeline:
///   build envelope → size-cap (upstream in 04-02) → sign → POST → on-failure-enqueue.
///
/// Wave-3 file-ownership note: this class ships standalone. The wiring of
/// `ReportSubmitter` construction + `drainOutbox()` into TraceItX.swift's
/// `start()` detached Task is owned by 04-06 atomically, alongside other
/// start()/kill() integration. This avoids Wave-3 file collisions on
/// TraceItX.swift with parallel plans 04-03 and 04-04.
///
/// Sibling type dependencies (resolved at wave-merge):
///   - `TraceItXConfig`           — 04-01 (`Config/TraceItXConfig.swift`)
///   - `TraceItXTransportError`   — 04-01 (`Errors/...`)
public final class ReportSubmitter: Sendable {

    public let config: TraceItXConfig
    public let outbox: JSONLOutbox
    private let session: URLSession
    private let authorizeUpload: (@MainActor @Sendable () -> Bool)?

    public convenience init(
        config: TraceItXConfig,
        outbox: JSONLOutbox = JSONLOutbox(),
        session: URLSession = ReportSubmitter.makeIsolatedSession()
    ) {
        self.init(config: config, outbox: outbox, session: session, authorizeUpload: nil)
    }

    private init(config: TraceItXConfig, outbox: JSONLOutbox, session: URLSession,
                 authorizeUpload: (@MainActor @Sendable () -> Bool)?) {
        self.config = config
        self.outbox = outbox
        self.session = session
        self.authorizeUpload = authorizeUpload
    }

    internal func authorizing(_ check: @escaping @MainActor @Sendable () -> Bool) -> ReportSubmitter {
        ReportSubmitter(config: config, outbox: outbox, session: session, authorizeUpload: check)
    }

    /// One outbound attachment. Mirrors `OutboxEntry.AttachmentRef` but stays
    /// API-friendly with raw `Data` instead of base64.
    public struct Attachment: Sendable {
        public let name: String
        public let filename: String
        public let contentType: String
        public let data: Data
        public let sha256Hex: String

        public init(name: String, filename: String, contentType: String, data: Data, sha256Hex: String) {
            self.name = name
            self.filename = filename
            self.contentType = contentType
            self.data = data
            self.sha256Hex = sha256Hex
        }
    }

    /// Submit one report. Returns:
    ///   - `.submitted(reportId:)` on HTTP 2xx
    ///   - `.queued(reportId:)`     on transient/retryable failure (network down,
    ///     5xx, 408, 429) — the entry is enqueued to the outbox for later drain
    /// Throws `TraceItXTransportError` on terminal HTTP errors (4xx other than
    /// 408/429) or genuinely unrecoverable transport errors.
    /// - Parameter companionAttribution: see `MultipartUploader.upload`. Not
    ///   persisted with an outbox entry: a report that falls back to the
    ///   outbox is retried later, potentially after the pair (and the token's
    ///   10-minute TTL) is long gone, so the retry submits unattributed rather
    ///   than with a token ingest would reject.
    /// - Parameters sdkKey/endpoint: the credentials this report was CAPTURED
    ///   under. `nil` means "use the active config" — the live submit path.
    ///   `drainOutbox` passes the entry's own values, so a queued report always
    ///   reaches the project that captured it, and a transient failure
    ///   re-enqueues it with its ORIGINAL key rather than the active one.
    /// - Parameter identitySubject: the verified-identity subject this report
    ///   was CAPTURED under (`TXCapturedUser.identitySubject` on the live
    ///   path, `OutboxEntry.identitySubject` on drain) — persisted onto the
    ///   outbox entry if this attempt fails transiently, so a retry keeps the
    ///   ORIGINAL captured subject rather than losing it. This function does
    ///   not itself decide whether a header is attached; see `identityToken`.
    /// - Parameter identityToken: the value to present as
    ///   `X-TX-Identity-Token`, already resolved by the caller via
    ///   `resolveIdentityHeader(capturedSubject:holder:config:now:)`. `nil`
    ///   sends the report anonymously. Kept separate from `identitySubject`
    ///   because the two answer different questions: the subject is what to
    ///   REMEMBER if this attempt has to be re-queued, the token is what to
    ///   PRESENT on this attempt.
    public func submit(
        envelopeBytes: Data,
        idempotencyKey: String,
        attachments: [Attachment],
        reportId: UUID = UUID(),
        companionAttribution: String? = nil,
        sdkKey: String? = nil,
        endpoint: String? = nil,
        identitySubject: String? = nil,
        identityToken: String? = nil
    ) async throws -> ReportResult {

        let effectiveKey = sdkKey ?? config.appId
        let effectiveEndpoint = endpoint ?? IngestEndpoint.url.absoluteString
        let effectiveURL = URL(string: effectiveEndpoint) ?? IngestEndpoint.url

        var uploader = MultipartUploader(endpoint: effectiveURL, sdkKey: effectiveKey)
        uploader.authorizeUpload = authorizeUpload
        var parts: [MultipartUploader.Part] = [
            .init(name: "envelope", filename: "envelope.json", contentType: "application/json", data: envelopeBytes)
        ]
        for a in attachments {
            parts.append(.init(name: a.name, filename: a.filename, contentType: a.contentType, data: a.data))
        }

        do {
            let (status, headers) = try await uploader.upload(
                parts: parts,
                idempotencyKey: idempotencyKey,
                companionAttribution: companionAttribution,
                identityToken: identityToken,
                urlSession: session
            )
            if (200...299).contains(status) {
                return .submitted(reportId: reportId)
            }
            switch RetryPolicy.classify(statusCode: status, headers: headers, error: nil) {
            case .retryable, .retryAfter:
                try enqueueToOutbox(
                    reportId: reportId,
                    envelopeBytes: envelopeBytes,
                    idempotencyKey: idempotencyKey,
                    attachments: attachments,
                    sdkKey: effectiveKey,
                    endpoint: effectiveEndpoint,
                    identitySubject: identitySubject
                )
                return .queued(reportId: reportId)
            case .terminal:
                NSLog("[TraceItX] submit failed (server status=\(status))")
                throw TraceItXTransportError.serverError(status: status)
            }
        } catch let urlError as URLError {
            switch RetryPolicy.classify(statusCode: nil, headers: [:], error: urlError) {
            case .retryable, .retryAfter:
                try enqueueToOutbox(
                    reportId: reportId,
                    envelopeBytes: envelopeBytes,
                    idempotencyKey: idempotencyKey,
                    attachments: attachments,
                    sdkKey: effectiveKey,
                    endpoint: effectiveEndpoint,
                    identitySubject: identitySubject
                )
                return .queued(reportId: reportId)
            case .terminal:
                NSLog("[TraceItX] submit failed (network error code=\(urlError.code.rawValue))")
                throw TraceItXTransportError.networkUnavailable
            }
        }
    }

    /// Best-effort drain of the persistent outbox: hydrate all entries, attempt
    /// each one in order, remove successes (and queue-on-failure re-enqueues
    /// transient failures). Safe to invoke from `start()`'s detached Task —
    /// 04-06 owns that wiring.
    ///
    /// - Parameters identityHolder/currentReplayConfig: how this pass
    ///   resolves each entry's `X-TX-Identity-Token`, via
    ///   `resolveIdentityHeader(capturedSubject: e.identitySubject, holder:,
    ///   config:, now:)` — mirroring how `sdkKey`/`endpoint` above come from
    ///   each entry rather than the live config, EXCEPT that the subject is
    ///   the only piece that is captured: the holder and the enablement gate
    ///   are read live because there is only ever one current token and one
    ///   current `identity.enabled` — `resolveIdentityHeader` itself is what
    ///   keeps a live token from crossing onto a report captured under a
    ///   different subject.
    ///
    ///   Deliberately NO defaults (Task 8b). A default `IdentityTokenHolder()`
    ///   / `.off` pair is indistinguishable from a caller that forgot to pass
    ///   anything — every production call site used to rely on exactly that
    ///   default, which is how this gate shipped wired-but-inert: reachable,
    ///   tested, and never actually invoked with a holder capable of resolving
    ///   a token. Every caller — `TraceItX.start()`'s launch drain, the crash
    ///   path's immediate non-fatal drain, and every test — must now name the
    ///   real singleton holder and the live `ReplayConfig` accessor (or an
    ///   explicit `.off` fixture) so the compiler forces the decision instead
    ///   of silently defaulting to "identity never attaches."
    ///
    ///   Independent review, round 11, P1(c) — `currentReplayConfig` is a
    ///   closure, not a captured value: this drain loop can run for minutes
    ///   across many entries (each attempt can spend a full network timeout
    ///   before falling back to retryable-queue), and a SINGLE `ReplayConfig`
    ///   value captured once, before the loop, went stale the moment remote
    ///   config disabled identity partway through — later entries in the same
    ///   pass kept invoking the provider and attaching tokens on the strength
    ///   of a decision that was already reversed. Called FRESH per entry,
    ///   both BEFORE `resolveIdentityHeader` (so a config that has already
    ///   flipped off by the time this entry's turn comes never even reaches
    ///   the holder) and AGAIN immediately after it returns (closing the
    ///   identical TOCTOU shape `currentEpoch`'s own before/after pair closes
    ///   two lines below — `resolveIdentityHeader` is `async`, and its own
    ///   suspension, the holder's provider re-ask, gives a config flip DURING
    ///   resolution a second window to land). This is ONLY the enablement
    ///   decision — routing (`e.sdkKey`/`e.endpoint`, compared against THIS
    ///   submitter's own frozen `config`/`IngestEndpoint.url` immediately
    ///   below) stays bound to the entry's OWN captured project, exactly as
    ///   rounds 6/7 established: "which project may this token attach to" is
    ///   still frozen at capture time; only "is identity even turned on right
    ///   now" is re-read live.
    /// - Parameter epochAtInitiation: independent review, round 8, Serious 1
    ///   — the epoch that was live at the moment THIS DRAIN WAS DECIDED
    ///   (captured by the caller, synchronously, alongside/immediately
    ///   after the `config` this submitter was constructed with — e.g.
    ///   `start()`'s `[config, epoch]` Task-capture list, or a same-scope
    ///   `TraceItX.shared.currentStartEpoch` read right before
    ///   `ReportSubmitter(config:)` is constructed for a non-fatal crash's
    ///   immediate drain). NOT the same value the OLD `epochAtDrainStart`
    ///   used to compute by calling `currentEpoch()` once at the top of
    ///   THIS function's own body — that was the bug. Both this function
    ///   and its callers are invoked from an unstructured `Task` that can
    ///   sit unscheduled for an arbitrary amount of time (Task-scheduling
    ///   delay, an `await currentReplayConfig()` ahead of the call, a slow
    ///   network drain of an earlier entry); a `start(projectB)` landing
    ///   ANY time in that gap — before this function's body ever starts
    ///   running, not just during it — was invisible to a baseline sampled
    ///   from inside this function, because that baseline would already
    ///   reflect project B by the time it was taken. Concretely: a
    ///   submitter built under project A, whose drain is initiated but
    ///   doesn't actually run until after `start(projectB)` landed, used to
    ///   sample `epochAtDrainStart` = B's epoch (correct-looking, but the
    ///   WRONG reference point), while `e.sdkKey == config.appId` still
    ///   compared against A (this submitter's own frozen config) and
    ///   passed — so project B's live token (same `sub`, plausible) could
    ///   attach to a request authorized with project A's SDK key, to
    ///   project A's endpoint: disclosure of a live bearer credential to
    ///   the wrong project's host, not merely misattribution (`aud`
    ///   verification stops the latter but not the former).
    /// - Parameter currentEpoch: a LIVE read of
    ///   `TraceItX.shared.currentStartEpoch`, supplied as a closure so this
    ///   file stays decoupled from the singleton (same reason
    ///   `identityHolder`/`replayConfig` are passed in rather than read
    ///   here). Compared against `epochAtInitiation` — never against
    ///   itself/a value it produced — both BEFORE `resolveIdentityHeader`
    ///   is ever called (so a mismatch already known at loop-entry skips
    ///   the resolve entirely) and again AFTER it returns, before the
    ///   result is ever used: `resolveIdentityHeader` is `async`, and its
    ///   own suspension (the holder's provider re-ask) gives a
    ///   `start(projectB)` + `setIdentityToken(B)` landing DURING
    ///   resolution — after the pre-check already passed — a second window
    ///   to land, the same TOCTOU shape independent review, Serious 2
    ///   closed for the live submit path (`ReporterSubmission.swift`).
    public func drainOutbox(
        identityHolder: IdentityTokenHolder,
        currentReplayConfig: @Sendable () async -> ReplayConfig,
        epochAtInitiation: Int,
        currentEpoch: @Sendable () -> Int
    ) async {
        let entries = (try? outbox.hydrate()) ?? []
        for e in entries {
            // Keep the durable copy until acceptance. A crash, cancellation or
            // failed re-enqueue during the request must not lose the report.

            let attachments: [Attachment] = e.attachmentRefs.map {
                Attachment(
                    name: $0.name,
                    filename: $0.filename,
                    contentType: $0.contentType,
                    data: Data(base64Encoded: $0.dataBase64) ?? Data(),
                    sha256Hex: $0.sha256Hex
                )
            }
            // Final whole-branch review, Important 2 — the identity header
            // had no project binding, unlike everything around it. This
            // function's own upload two lines below deliberately uses the
            // ENTRY's own `sdkKey`/`endpoint`, never the live `config`, for
            // exactly the reason `enqueueToOutbox`'s doc states: "a queued
            // report belongs to the project that captured it; draining it
            // under whatever key start() was last handed is a cross-tenant
            // leak of the whole report." The identity header used to be
            // exempt from that rule — resolved from the LIVE holder/config
            // regardless of which project `e` actually belongs to.
            //
            // Concretely: start(projectA) queues a report (sdkKey=A,
            // identitySubject="u_42") -> start(projectB) ->
            // setIdentityToken(B's token, whose sub is ALSO "u_42" — likely,
            // since sub is the host's own user id, unchanged across a
            // tenant or dev/prod switch) -> drain fires -> project B's LIVE
            // bearer credential would ship to project A's endpoint, which
            // may be a different host entirely. Server-side `aud` checking
            // stops misattribution, but this is disclosure of a live bearer
            // credential to another tenant's ingest.
            //
            // Independent review, round 4 (Serious 1) — the sdkKey check
            // alone is not the full binding `sdkKey`/`endpoint` themselves
            // already have two lines below (`sdkKey: e.sdkKey, endpoint:
            // e.endpoint`, always the ENTRY's own values). PR #63 stored the
            // endpoint alongside the key specifically because "the endpoint
            // is independently redirectable, so a key alone can still reach
            // the wrong host" — a dev-override `TRACEITX_DEV_INGEST_URL`
            // changing between when this entry was queued and when it
            // drains would otherwise let a live token attach to an entry
            // whose upload destination is a DIFFERENT host, even though its
            // sdkKey still matches. The header must follow the same rule
            // its neighbours already follow.
            //
            // Refuse the header outright unless the entry's own sdkKey AND
            // endpoint both still match the live ones — the same binding
            // `sdkKey`/`endpoint` already have, now extended to the header.
            let identityToken: String?
            if e.sdkKey == config.appId
                && e.endpoint == IngestEndpoint.url.absoluteString
                && currentEpoch() == epochAtInitiation {
                // Round 11, P1(c) — read live, FRESH for THIS entry, not once
                // for the whole drain: a long drain can span a remote config
                // change, and only the CURRENT enablement decision may ever
                // gate a token.
                let resolved = await resolveIdentityHeader(
                    capturedSubject: e.identitySubject,
                    holder: identityHolder,
                    config: await currentReplayConfig(),
                    now: Date()
                )
                // Re-read AGAIN after resolution, not just re-check the
                // epoch: `resolveIdentityHeader`'s own suspension (the
                // holder's provider re-ask) gives a config flip DURING
                // resolution a second window to land, the same TOCTOU shape
                // the epoch re-check closes for project switches. Computed
                // as its own `let` — `&&`'s right-hand side is an
                // `@autoclosure`, which cannot contain `await`.
                let stillEnabled = isIdentityEnabled(await currentReplayConfig())
                identityToken = (currentEpoch() == epochAtInitiation && stillEnabled) ? resolved : nil
            } else {
                identityToken = nil
            }
            do {
                let result = try await submit(
                    envelopeBytes: e.envelopeBytes,
                    idempotencyKey: e.idempotencyKey,
                    attachments: attachments,
                    reportId: e.reportId,
                    sdkKey: e.sdkKey,
                    endpoint: e.endpoint,
                    identitySubject: e.identitySubject,
                    identityToken: identityToken
                )
                if case .submitted = result {
                    try outbox.drain(where: { $0.reportId == e.reportId })
                }
            } catch TraceItXTransportError.serverError {
                // submit throws serverError only for terminal HTTP statuses.
                try? outbox.drain(where: { $0.reportId == e.reportId })
            } catch {
                // Retain the original encrypted entry. Retrying a server-accepted
                // request is safe because its idempotency key stays unchanged.
            }
        }
    }

    // MARK: - Private

    private func enqueueToOutbox(
        reportId: UUID,
        envelopeBytes: Data,
        idempotencyKey: String,
        attachments: [Attachment],
        sdkKey: String,
        endpoint: String,
        identitySubject: String? = nil
    ) throws {
        let entry = OutboxEntry(
            reportId: reportId,
            createdAt: Date(),
            envelopeBytes: envelopeBytes,
            idempotencyKey: idempotencyKey,
            attachmentRefs: attachments.map {
                OutboxEntry.AttachmentRef(
                    name: $0.name,
                    filename: $0.filename,
                    contentType: $0.contentType,
                    dataBase64: $0.data.base64EncodedString(),
                    sha256Hex: $0.sha256Hex
                )
            },
            sdkKey: sdkKey,
            endpoint: endpoint,
            identitySubject: identitySubject
        )
        try outbox.enqueue(entry)
    }

    /// The isolated session every `ReportSubmitter` uses by default. Returns
    /// the SAME, process-lifetime instance on every call — see
    /// `sharedIsolatedSession`'s own doc comment for why.
    public static func makeIsolatedSession() -> URLSession {
        sharedIsolatedSession
    }

    /// Independent review, round 14 (codex round 12), Serious 3 — round 13
    /// made `makeIsolatedSession()` install `IdentityHeaderRedirectGuard` as
    /// the session's DELEGATE, which made every session it builds
    /// delegate-backed. Apple documents that a delegate-backed
    /// `URLSession` is retained by the system until `invalidateAndCancel()`
    /// or `finishTasksAndInvalidate()` is called — it does not simply get
    /// deallocated once nothing references it. `ReportSubmitter.init`'s
    /// default parameter (`session: URLSession = ReportSubmitter
    /// .makeIsolatedSession()`) used to build a FRESH one on every call, and
    /// `ReporterSubmission.swift` constructs a fresh `ReportSubmitter` for
    /// every ordinary report — so every submission leaked one more session,
    /// delegate, and delegate queue for the life of the process.
    ///
    /// Fix: stop building a session per submitter at all. One shared,
    /// properly-owned session, built lazily exactly once (Swift's `static
    /// let` initializer is thread-safe by construction, the same guarantee
    /// `URLSession.shared` itself relies on) and never invalidated — a
    /// process-lifetime singleton needs no invalidation step, so there is no
    /// "wrong moment" to pick and no risk of the trap the coordinator named:
    /// calling `finishTasksAndInvalidate()` at the wrong time would cancel
    /// whatever upload is currently in flight, and this branch has already
    /// turned an identity fix into a dropped report three times. Sharing
    /// sidesteps the question entirely rather than answering it correctly
    /// under pressure.
    ///
    /// This is not a new pattern for this file, only a wider application of
    /// one already in use: `drainOutbox()` already reuses ONE
    /// `ReportSubmitter`'s session across MANY sequential uploads in a
    /// single pass (see that method's own doc comment) — proof that sharing
    /// this session across multiple uploads is already the working,
    /// load-bearing shape here, not a new risk introduced by widening it
    /// across submitter INSTANCES too. It also brings iOS in line with
    /// Android, where `ReportSubmitter.buildIsolatedClient()`'s
    /// `OkHttpClient` doesn't carry this specific leak (OkHttp clients don't
    /// require explicit invalidation) but was always intended to be reused
    /// rather than rebuilt per submit, for the same connection-pooling
    /// reason a shared `URLSession` is cheaper than N one-shot ones.
    ///
    /// Every session this produces is IDENTICAL by construction (same
    /// `URLSessionConfiguration.default` base, same protocol-class filter,
    /// same `IdentityHeaderRedirectGuard` delegate instance) — there was
    /// never any per-call customization to lose by sharing one instance
    /// instead of building N indistinguishable ones.
    private static let sharedIsolatedSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.protocolClasses = (cfg.protocolClasses ?? []).filter { cls in
            let name = NSStringFromClass(cls)
            // Owned by 04-04; filter by name to keep the dep soft.
            return !name.contains("TXNetworkCaptureProtocol")
        }
        return URLSession(configuration: cfg, delegate: IdentityHeaderRedirectGuard(), delegateQueue: nil)
    }()

    /// Session Vitals (iOS spec 2026-09-05 §2): the vitals transport shares this
    /// session so a start()/kill() cycle never leaks a one-shot URLSession.
    internal static var sharedIsolatedSessionForVitals: URLSession { sharedIsolatedSession }
}

/// Independent review, round 13, Serious — `MultipartUploader.upload`
/// attaches `X-TX-Identity-Token` to the ingest POST, but `URLSession`
/// follows redirects by default, and Foundation's handling of a CUSTOM
/// header on a cross-origin redirect is not documented and is NOT the same
/// as its handling of `Authorization`.
///
/// Established empirically, not assumed — the same discipline used earlier
/// on this branch to pin Foundation's `setValue`/CRLF behaviour
/// (`IdentityTokenHolderTests.swift`'s
/// `testFoundationSilentlyDropsAHeaderValueContainingCRLF`): two REAL local
/// HTTP servers on 127.0.0.1 (different ports — and separately, different
/// hostnames — both count as a different origin), server A responding 302
/// to server B, with a plain `URLSession` and no delegate installed.
/// Result: `Authorization` was stripped by Foundation itself before the
/// follow-up request was ever sent (confirming the same protection OkHttp
/// already provides on Android); `X-TX-Identity-Token` — and, separately,
/// `X-TX-Companion-Attribution` — were NOT stripped and arrived at server
/// B intact. A `URLProtocol`-based mock (`RecordingURLProtocol`, used
/// elsewhere in this test target) could not have answered this: a custom
/// `URLProtocol` substitutes the real network transport entirely and
/// constructs its OWN proposed redirect request via `wasRedirectedTo:`,
/// so it never exercises Foundation's actual, real header-copying logic —
/// only a REAL two-hop network round-trip does.
///
/// `URLSessionTaskDelegate.urlSession(_:task:willPerformHTTPRedirection:
/// newRequest:completionHandler:)` is the one hook Foundation offers before
/// a redirect is actually followed: called with the PROPOSED follow-up
/// request, letting the delegate hand back either that request unchanged,
/// a MODIFIED one, or `nil` to cancel the redirect outright (the redirect
/// response itself then becomes the task's final result).
///
/// This strips the header and lets the redirect PROCEED, rather than
/// cancelling it outright: rejecting a cross-origin redirect would turn an
/// ordinary, legitimate server-side redirect (a load balancer or CDN
/// change, a scheme upgrade to a different edge host) into a dropped
/// report — recognition must never fail or stall a report, the same rule
/// this feature has already needed twice on this branch (round 3's
/// provider-cancellation handling, round 6's malformed-token handling).
/// Stripping degrades to the anonymous direction instead: the report still
/// reaches wherever the server actually wanted it, just without presenting
/// a credential to a host that never should have seen it.
///
/// Deliberately does NOT touch `X-TX-Companion-Attribution` — established
/// above to have the identical exposure, but it predates this branch and
/// is out of scope for this fix; flagged for its own follow-up.
final class IdentityHeaderRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let originalURL = task.originalRequest?.url, let newURL = request.url,
              !Self.isSameOrigin(originalURL, newURL)
        else {
            completionHandler(request)
            return
        }
        var stripped = request
        // `setValue(nil, forHTTPHeaderField:)` REMOVES the field entirely
        // (Foundation's own documented `NSMutableURLRequest` contract,
        // confirmed as part of the same empirical check above) — this is
        // not "send an empty header," it is "do not send this header at
        // all," which is what the leak fix requires.
        stripped.setValue(nil, forHTTPHeaderField: IDENTITY_TOKEN_HEADER)
        completionHandler(stripped)
    }

    /// Origin = scheme + host + port, mirroring the standard (browser)
    /// same-origin definition — matches what actually changes when a
    /// redirect crosses to a different host or a different port on the
    /// SAME host (both are "somewhere else" from the credential's point of
    /// view). `URL.port` is `nil` when the URL omits an explicit port, so
    /// both sides are resolved to their scheme's default port before
    /// comparing — otherwise `https://host` and `https://host:443` (the
    /// SAME origin) would be misclassified as cross-origin.
    private static func isSameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme == b.scheme && a.host == b.host && effectivePort(a) == effectivePort(b)
    }

    private static func effectivePort(_ url: URL) -> Int {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return -1
        }
    }
}
