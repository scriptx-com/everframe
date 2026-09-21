// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-envelope assembly for JS-error reports arriving over the RN bridge
// (spec 2026-07-18). Everything here is synchronous and JS-thread-safe:
// RedactionEngine, EnvelopeBuilder.buildEncoded, JSONLOutbox (queue.sync).
// DeviceMetadata.snapshot() is @MainActor, so device fields come from a
// cache primed on the main queue at prime() time — a crash before the cache
// fills degrades to Bundle.main-derived app fields only.
// v2 native (signal/NSException) capture is expected to reuse captureFacts.
//
// Adaptations vs. the task-13 brief's sketch (real generated-type names /
// call sites differ):
//   • `fingerprint(exceptionType:frameKeys:)` caps `frameKeys` to the first 5
//     entries INTERNALLY (verified against
//     packages/protocol/__tests__/fixtures/crash-fingerprint.json, whose 4th
//     case supplies 6 frames and expects the 6th ignored) — callers pass the
//     FULL frame-key list, uncapped.
//   • Automatic capture is unhandled; explicit captureException is handled.
//     Both paths persist an explicit fatal flag alongside source.
//   • `sdkName` threads through so the RN bridge can identify itself
//     ("traceitx-react-native") distinctly from a native-iOS host
//     ("traceitx-ios", the default) — mirrors Android's Task 12 handling of
//     the same wire shape.
import CryptoKit
import Foundation
import TraceItXProtocol

public enum CrashReporter {

    private static let lock = NSLock()
    nonisolated(unsafe) private static var cachedDevice: DeviceMetadata?
    nonisolated(unsafe) private static var handling = false
    nonisolated(unsafe) private static var handlingNativeHandled = false
    private static let handledAdmission = HandledErrorAdmission {
        TraceItX.shared.currentStartEpoch
    }

    /// Test-only seam. Invoked immediately after the crash-entry user snapshot
    /// (see `captureFacts`), i.e. INSIDE the exact window a concurrent
    /// `setUser`/`start()` has to land in for the round-5 finding-2 defect.
    /// Production leaves this nil; the cost on the crash path is one nil check.
    /// Mirrors `TraceItX.__startTailDelayHookForTesting`'s convention.
    nonisolated(unsafe) internal static var __afterUserSnapshotHookForTesting: (() -> Void)?

    /// Lets tests retain/await or suppress the drain without replacing persistence.
    /// Production leaves this nil and schedules the same captured operation in a Task.
    nonisolated(unsafe) internal static var __scheduleDrainForTesting: ((@escaping @Sendable () async -> Void) -> Void)?

    private enum Classification { case automatic, handled }

    /// Prime the device-metadata cache. Call at start()/configure() time.
    public static func prime() {
        DispatchQueue.main.async {
            let snap = DeviceMetadata.snapshot()
            lock.lock(); cachedDevice = snap; lock.unlock()
        }
    }

    private struct Facts: Decodable {
        let exceptionType: String?
        let message: String?
        let framesRaw: [String]?
        let fatal: Bool?
        let occurredAt: String?
        let mechanism: String?
        let jsBundle: JSBundle?
        let details: RNCrashDetailsWire?

        enum CodingKeys: String, CodingKey {
            case exceptionType, message, framesRaw, fatal, occurredAt, mechanism, jsBundle, details
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            exceptionType = try? values.decode(String.self, forKey: .exceptionType)
            message = try? values.decode(String.self, forKey: .message)
            framesRaw = try? values.decode([String].self, forKey: .framesRaw)
            fatal = try? values.decode(Bool.self, forKey: .fatal)
            occurredAt = try? values.decode(String.self, forKey: .occurredAt)
            mechanism = try? values.decode(String.self, forKey: .mechanism)
            // Decode independently: even invalid Unicode in optional identity must
            // not prevent valid raw facts from being persisted.
            jsBundle = try? values.decode(JSBundle.self, forKey: .jsBundle)
            // `contains` preserves legacy absence. Present null, a non-object,
            // or any field-local decode failure becomes explicit optional loss.
            details = values.contains(.details)
                ? ((try? values.decode(RNCrashDetailsWire.self, forKey: .details)) ?? .invalid)
                : nil
        }

        init(
            exceptionType: String,
            message: String,
            framesRaw: [String],
            occurredAt: String,
            mechanism: String
        ) {
            self.exceptionType = exceptionType
            self.message = message
            self.framesRaw = framesRaw
            self.fatal = false
            self.occurredAt = occurredAt
            self.mechanism = mechanism
            self.jsBundle = nil
            self.details = nil
        }
    }

    private static func validJsBundle(_ bundle: JSBundle?) -> JSBundle? {
        guard let bundle,
              !bundle.buildID.isEmpty, bundle.buildID.utf16.count <= 200,
              bundle.buildID.range(of: "[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]", options: .regularExpression) != nil,
              !bundle.buildID.contains("\u{0}"),
              bundle.bundleName.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\z", options: .regularExpression) != nil
        else { return nil }
        return bundle
    }

    /// Parse crash-facts JSON (Task 11 wire shape), build + persist. Returns
    /// success. `outbox`/`config` injectable for tests; production callers
    /// pass the defaults. `sdkName` defaults to the native-iOS identity;
    /// the RN bridge passes `"traceitx-react-native"`.
    ///
    /// `config` defaults to `nil` meaning "take it from the crash-entry
    /// session snapshot below", NOT to `TraceItX.shared.currentConfig`
    /// evaluated as a default argument. A default argument is evaluated at
    /// the CALL SITE, before this function's body runs — which would put the
    /// config read ahead of the crash-entry snapshot and so outside the
    /// window it captures (see below). Every existing caller either passes a
    /// real config (tests) or relies on the default (the RN bridge), so the
    /// observable behaviour is unchanged.
    public static func captureFacts(
        json: String,
        sdkName: String = "traceitx-ios",
        outbox: JSONLOutbox = JSONLOutbox(),
        config: TraceItXConfig? = nil
    ) -> Bool {
        capture(json: json, sdkName: sdkName, outbox: outbox, config: config, classification: .automatic)
    }

    /// Persist an explicit exception. Acceptance means encrypted enqueue completed,
    /// subject to the outbox's existing capacity policy; it is not network receipt.
    public static func captureHandledFacts(
        json: String,
        sdkName: String = "traceitx-ios",
        outbox: JSONLOutbox = JSONLOutbox(),
        config: TraceItXConfig? = nil
    ) -> Bool {
        capture(json: json, sdkName: sdkName, outbox: outbox, config: config, classification: .handled)
    }

    /// Capture a caught native Error. `true` means encrypted enqueue completed;
    /// it does not acknowledge network delivery.
    internal static func captureHandledError(
        _ error: any Error,
        options: CaptureExceptionOptions? = nil,
        outbox: JSONLOutbox = JSONLOutbox()
    ) -> Bool {
        // This latch is independent from the JSON automatic/fatal latch. A
        // host description may reenter this API, but it must not suppress an
        // automatic fatal capture on another thread.
        lock.lock()
        if handlingNativeHandled {
            lock.unlock()
            return false
        }
        handlingNativeHandled = true
        let device = cachedDevice
        lock.unlock()
        defer {
            lock.lock()
            handlingNativeHandled = false
            lock.unlock()
        }

        // Snapshot and eligibility checks happen before NSError bridging,
        // localizedDescription or stack extraction can invoke host behavior.
        let captured = TraceItX.shared.captureSessionSnapshot()
        guard TraceItX.captureGate,
              let config = captured.config,
              config.capture.crash,
              !captured.isSuperseded,
              let reservation = handledAdmission.reserve(
                  error,
                  capturedEpoch: captured.user.startEpoch
              )
        else { return false }

        var accepted = false
        defer { handledAdmission.settle(reservation, durablyAccepted: accepted) }

        let detailsRedactor = RedactionEngine()
        let details = normalizeCrashDetails(options) { detailsRedactor.redact($0) }
        let exceptionType: String
        if type(of: error) is NSError.Type {
            let nsError = error as NSError
            exceptionType = "\(nsError.domain):\(nsError.code)"
        } else {
            exceptionType = String(reflecting: type(of: error))
        }
        let facts = Facts(
            exceptionType: exceptionType,
            message: error.localizedDescription,
            framesRaw: Array(Thread.callStackSymbols.prefix(256)),
            occurredAt: ISO8601DateFormatter().string(from: Date()),
            mechanism: "captureException"
        )
        accepted = capture(
            facts: facts,
            sdkName: "traceitx-ios",
            outbox: outbox,
            config: config,
            classification: .handled,
            captured: captured,
            device: device,
            requireCurrentSession: true,
            details: details
        )
        return accepted
    }

    private static func capture(
        json: String, sdkName: String, outbox: JSONLOutbox,
        config: TraceItXConfig?, classification: Classification
    ) -> Bool {
        // Own the latch before any callback can reenter either public path.
        lock.lock()
        if handling { lock.unlock(); return false }
        handling = true
        let device = cachedDevice
        lock.unlock()
        defer { lock.lock(); handling = false; lock.unlock() }

        // CRASH ENTRY — round-5 external review, finding 2 (Serious).
        //
        // The self-declared user used to be read at envelope-assembly time,
        // ~80 lines below: after JSON parsing, after RedactionEngine ran over
        // the message and up to 256 stack frames, after fingerprinting and
        // after device-metadata assembly. A `setUser(B)` landing in that window
        // attributed A's crash to B, and a `start(projectB)` crossed a project
        // boundary outright because the user was bound to no session at all.
        //
        // Snapshot it HERE instead, at the instant the crash arrives, and
        // `resolve()` it against its own session at encode time — the same
        // mechanism the reporter and companion submit paths use.
        //
        // Blocking: `captureSessionSnapshot()` takes `TraceItX.stateLock` for
        // one uncontended critical section (user, config and kill generation,
        // all three) — the SAME lock the removed `currentUser`/`currentConfig`
        // reads took, so this is a move, not a new acquisition, and it cannot
        // make this path block where it did not before. This is also not an
        // async-signal context: `captureFacts` is called from the RN bridge on
        // an ordinary thread and already parses JSON, allocates and writes to
        // disk below.
        let captured = TraceItX.shared.captureSessionSnapshot()
        __afterUserSnapshotHookForTesting?()

        // Read AFTER the snapshot, so a still-matching epoch at `resolve()`
        // time proves no start()/kill() ran across the whole window, this
        // config read included (the ordering rule ReporterSubmission.swift
        // documents and its source gate pins).
        //
        // Merge note (native-identity x captured-session): this used to be a
        // SEPARATE `TraceItX.shared.captureConfigSnapshot()` call, its own
        // `stateLock` acquisition after the one that produced `captured`
        // above. `TXCapturedSession.config` (via `captureSessionSnapshot()`)
        // now carries the identical value from the SAME critical section
        // that captured `user`/`identitySubject`/the generation counters, so
        // reading `captured.config` here removes that second acquisition
        // instead of merely mirroring its atomicity. The comment this
        // replaces argued that a still-matching epoch at `resolve()` time
        // proved the config read was clean. That was true and insufficient:
        // it described the happy path, while a mismatch only ever dropped
        // the USER and left the report to ship under whatever key the later
        // read returned. Capturing the config alongside the user removes the
        // read outright.
        guard let config = config ?? captured.config, config.capture.crash else {
            return false
        }
        guard let data = json.data(using: .utf8),
              let facts = try? JSONDecoder().decode(Facts.self, from: data),
              facts.exceptionType != nil
        else { return false }
        return capture(
            facts: facts,
            sdkName: sdkName,
            outbox: outbox,
            config: config,
            classification: classification,
            captured: captured,
            device: device,
            requireCurrentSession: false
        )
    }

    private static func capture(
        facts: Facts,
        sdkName: String,
        outbox: JSONLOutbox,
        config: TraceItXConfig,
        classification: Classification,
        captured: TXCapturedSession,
        device: DeviceMetadata?,
        requireCurrentSession: Bool,
        details: CrashDetails? = nil
    ) -> Bool {
        guard let exceptionType = facts.exceptionType else { return false }
        let capturedUser = captured.user
        let redactor = RedactionEngine()
        let resolvedDetails = details ?? normalizeRNCrashDetails(facts.details) {
            redactor.redact($0)
        }
        let message = CrashText.redactedAndCapped(
            facts.message ?? "", utf16Limit: 4096, redactor: redactor
        )
        let framesRaw = (facts.framesRaw ?? [])
            .prefix(256).map {
                CrashText.redactedAndCapped($0, utf16Limit: 1024, redactor: redactor)
            }
        let handled = classification == .handled
        let fatal = handled ? false : (facts.fatal ?? false)
        let occurredAt = facts.occurredAt ?? ISO8601DateFormatter().string(from: Date())
        let mechanism = CrashText.redactedAndCapped(
            handled ? "captureException" : (facts.mechanism ?? "errorutils"),
            utf16Limit: 64,
            redactor: redactor
        )
        let cappedExceptionType = CrashText.redactedAndCapped(
            exceptionType, utf16Limit: 256, redactor: redactor
        )

        // Frame-key derivation for fingerprinting: raw text with digit runs
        // stripped (function/file are never split out of the RN wire shape's
        // framesRaw — mirrors Android's captureFacts, which always takes the
        // `Frame(raw = ...)` branch too). The 5-frame cap lives INSIDE
        // fingerprint(), not here — see that function's doc comment.
        let frameKeys = framesRaw.map {
            $0.replacingOccurrences(of: "[0-9]+", with: "", options: .regularExpression)
        }
        let fp = fingerprint(exceptionType: cappedExceptionType, frameKeys: frameKeys)

        let crash = Crash(
            details: resolvedDetails,
            exceptionType: cappedExceptionType,
            fatal: fatal,
            fingerprint: fp,
            frames: framesRaw.map { Frame(col: nil, file: nil, function: nil, line: nil, raw: $0) },
            handled: handled,
            jsBundle: validJsBundle(facts.jsBundle),
            jvm: nil,
            mechanism: mechanism,
            message: message,
            occurredAt: parseOccurredAt(occurredAt),
            threadName: nil
        )

        var extra: [String: String] = [
            "title": String("\(cappedExceptionType): \(message)".prefix(50)),
            "description": "",
            "captureControl.degradedReason": "crash-capture",
        ]
        if let d = device {
            extra["device.model"] = d.model
            extra["device.os"] = d.osName
            extra["device.osVersion"] = d.osVersion
            extra["device.locale"] = d.locale
            extra["device.timezone"] = d.timezone
            extra["device.screen.width"] = String(d.screenWidth)
            extra["device.screen.height"] = String(d.screenHeight)
            extra["device.pixelRatio"] = String(d.pixelRatio)
        }

        // Self-declared identity (spec 2026-08-12). EnvelopeBuilder reads these
        // three keys back into `reporter.user`, so a crash from a known person
        // is attributed too. Mirrors the identical block in
        // ReporterSubmission.swift — before this spec `setUser` stored `_user`
        // and nothing ever read it.
        //
        // Round-5 external review, finding 2 (Serious) — `capturedUser`
        // (snapshotted at crash entry, above), NEVER a live
        // `TraceItX.shared.currentUser` read here. `resolve()` returns the
        // captured user only while its session is still installed; a
        // `start()`/`kill()` since the crash arrived degrades this crash to
        // anonymous, which always beats attributing it to the wrong person.
        // (The wrong-project-key case is now prevented independently, by the
        // captured `config` above — this rule no longer carries that job.)
        if let user = capturedUser.resolve() {
            if let id = user.id { extra["user.id"] = id }
            if let email = user.email { extra["user.email"] = email }
            if let displayName = user.displayName { extra["user.displayName"] = displayName }
        }

        do {
            let reportId = UUID()
            // Session Vitals (codex round-1, Critical 1) — same rule as the captured user two
            // blocks up: the vitals stamp is bound to the epoch the CRASH was captured under,
            // so a start()/kill() arriving while this envelope is being assembled degrades it
            // to no vitals instead of attributing another project's session to this crash.
            let (bytes, idempotencyKey) = try EnvelopeBuilder(redactor: redactor, vitalsStartEpoch: capturedUser.startEpoch).buildEncoded(
                reportId: reportId,
                sdkName: sdkName,
                sdkVersion: TraceItX.SDK_VERSION,
                extra: extra,
                breadcrumbs: BreadcrumbRingBuffer.shared.snapshot(),
                // Report Resource Window (spec 2026-09-05) — same style as
                // breadcrumbs above: the live ring's snapshot, unconditional.
                // `EnvelopeBuilder.buildEncoded` treats nil/empty as a no-op
                // (byte-identical to the pre-resources builder), and
                // re-applies the 256 cap at the encode boundary regardless
                // of what the ring already enforced.
                source: fatal ? .crash : .error,
                crash: crash,
                resources: ResourceRingBuffer.shared.snapshot())
            // Checked HERE, not at capture time: a kill() arriving during
            // redaction/fingerprinting/device assembly must still suppress the
            // report, and an earlier check would miss exactly that window.
            // Monotonic, so a start() that re-opened `captureGate` in the
            // meantime cannot resurrect this.
            //
            // WHAT THIS GUARANTEES, EXACTLY: no write BEGINS after a revocation
            // is observed. It is not atomic with the `enqueue` below.
            // `killGenerationChanged` takes `stateLock`, compares, and releases
            // it before returning, so a `kill()` can bump the counter and return
            // in the gap between this check and the entry landing on disk — and
            // because `kill()` does not purge `JSONLOutbox`, the next `start()`
            // then drains that entry. External review 2026-08-13 (codex) raised
            // exactly this; it is accepted, deliberately, for two reasons.
            //
            // 1. The outcome is not new. A report written a millisecond BEFORE
            //    `kill()` reaches the same disk and uploads on the same next
            //    launch — that is already the documented scope of the kill
            //    guarantee (follow-ups register, item 6, "Scope of that kill
            //    guarantee: the WRITE, not the disk"). Closing this window
            //    converts one interleaving into the other; it removes no
            //    observable behaviour, because nothing purges what is on disk.
            // 2. The only way to make check and write atomic is to hold
            //    `stateLock` across the `enqueue`, and `kill()` itself takes
            //    `stateLock` (`TraceItX.swift`, its `stateLock.lock()` /
            //    `_killGeneration &+= 1` section). That would make a public
            //    kill-switch call block on filesystem I/O, on the crash path,
            //    while the SDK's central state lock — the one `setUser`,
            //    `start`, `addBreadcrumb` and every other API acquires — is held
            //    for the duration of a file write. That is a strictly worse
            //    trade than the window it closes.
            //
            // JSONLOutbox already serializes writes on one process-wide queue.
            // Ordering that queue against stateLock would still introduce a
            // lock-ordering hazard; capture deliberately releases SDK state
            // locks before filesystem I/O.
            //
            // What WOULD close the class is `kill()` purging the outbox, not
            // tightening this check. That is a product decision nobody has made;
            // see the register.
            if TraceItX.killGenerationChanged(since: captured.killGeneration)
                || (requireCurrentSession && captured.isSuperseded) {
                return false
            }

            // Native identity Task 8b — thread the ALREADY-CAPTURED subject
            // (snapshotted atomically with `capturedUser` at crash entry,
            // above) onto the entry. Without this a crash can never be
            // attributed, however identity is otherwise configured: the drain
            // that eventually submits this entry (immediately below, for a
            // non-fatal, or on the next `start()` for a fatal one) only ever
            // resolves a header from `entry.identitySubject` — no subject on
            // the entry means no header, permanently, regardless of what the
            // live holder/config are at drain time. This is a passthrough
            // only: no config is read here, and the critical section above
            // this point is unchanged (follow-up item 6 owns that).
            //
            // Independent review, P1 — but only while the captured session
            // is STILL current: the SAME `capturedUser.startEpoch ==
            // TraceItX.shared.currentStartEpoch` comparison
            // `capturedUser.resolve()` already performs internally for the
            // user above. A raw `TXCapturedUser` field (unlike `.user`) has
            // no built-in gate of its own, so it is made explicit here — an
            // epoch mismatch means the SDK has already decided the WHOLE
            // captured snapshot is untrustworthy, not just the self-declared
            // user half of it. Without this, a LATER drain could attach a
            // header on the strength of a subject the SDK had already
            // concluded it should not rely on.
            let capturedEpochStillCurrent = capturedUser.startEpoch == TraceItX.shared.currentStartEpoch
            try outbox.enqueue(OutboxEntry(
                reportId: reportId, createdAt: Date(), envelopeBytes: bytes,
                idempotencyKey: idempotencyKey, attachmentRefs: [],
                sdkKey: config.appId, endpoint: IngestEndpoint.url.absoluteString,
                identitySubject: capturedEpochStillCurrent ? capturedUser.identitySubject : nil))
            if !fatal {
                // Runtime survives — ship now instead of waiting for next launch.
                let submitter = ReportSubmitter(config: config, outbox: outbox)
                // Independent review, round 8, Serious 1 — captured
                // atomically with `config` (via `captured` above, at
                // the top of this function) and threaded through here
                // UNCHANGED, rather than read fresh at this later point.
                // `Task { }` below is unstructured and can sit unscheduled
                // for an arbitrary time; a `start(projectB)` landing
                // anywhere between the config read and the Task's body
                // actually executing must not be able to present project
                // B's live token on a request still authorized with project
                // A's SDK key.
                //
                // Independent review, round 9, P1 — this used to be a
                // SEPARATE `TraceItX.shared.currentStartEpoch` read at this
                // exact line, independent of the config read at the top of
                // the function. That reopened the same hazard one level up:
                // `start(projectB)` landing between the two reads paired
                // A's config with B's epoch, and both of `drainOutbox`'s
                // guards "passed" on that mismatched pair. Merge note
                // (native-identity x captured-session): `captured.user
                // .startEpoch` is the SAME value `captured.config` came from
                // — one `stateLock` critical section, via
                // `captureSessionSnapshot()` — never re-sampled, superseding
                // the old separate `TXCapturedConfig`/`captureConfigSnapshot()`
                // pairing this comment used to describe.
                let epochAtInitiation = captured.user.startEpoch
                let drain: @Sendable () async -> Void = {
                    await submitter.drainOutbox(
                        identityHolder: TraceItX.shared._identityHolder,
                        currentReplayConfig: { await TraceItX.shared.currentReplayConfig() },
                        epochAtInitiation: epochAtInitiation,
                        currentEpoch: { TraceItX.shared.currentStartEpoch }
                    )
                }
                if let schedule = __scheduleDrainForTesting {
                    schedule(drain)
                } else {
                    Task { await drain() }
                }
            }
            return true
        } catch {
            return false
        }
    }

    /// sha256(exceptionType + "\n" + first-5-frameKeys.joined("\n")), first 16
    /// lowercase hex chars. The 5-frame cap lives HERE (not at call sites) —
    /// verified against crash-fingerprint.json's 4th fixture case, which
    /// supplies 6 frames and expects the 6th to be ignored.
    public static func fingerprint(exceptionType: String, frameKeys: [String]) -> String {
        let capped = Array(frameKeys.prefix(5))
        let input = exceptionType + "\n" + capped.joined(separator: "\n")
        let digest = SHA256.hash(data: Data(input.utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(16))
    }

    /// `Crash.occurredAt` is a generated `Date` (ISO-8601 decode/encode). The
    /// JS-supplied wire value is already ISO-8601; fall back to "now" if it
    /// fails to parse (should not happen in practice — Task 11 always emits
    /// `new Date().toISOString()`).
    private static func parseOccurredAt(_ s: String) -> Date {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFractional.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: s) ?? Date()
    }
}
