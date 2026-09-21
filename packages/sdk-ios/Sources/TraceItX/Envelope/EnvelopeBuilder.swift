// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Concrete envelope composition for the iOS SDK. Wraps the quicktype-generated
// `ReportEnvelope` initializer with redaction + size-cap enforcement + SHA-256
// idempotency-key derivation.
//
// Plan 04-01 lands a CONCRETE composition (NOT a fixture passthrough): all
// function arguments propagate into the returned envelope via Generated.swift's
// synthesized memberwise initializer. Plan 04-02 wires the production
// `RedactionEngine`; plan 04-04 wires real Network/UIDevice context.
import Foundation
import CryptoKit
import TraceItXProtocol

public struct EnvelopeBuilder {
    /// PIPE-03 hard ceiling. Phase 1 doc lists 25 MB; STACK lists 8 MB for older
    /// guidance — 25 MB matches the receiver-side `the ingest service` cap.
    public static let SIZE_CAP_BYTES = 25 * 1024 * 1024


    // RedactionEngine is injected by 04-02. Until that file lands the no-op
    // default lets 04-01 ship a buildable scaffold.
    public protocol RedactingHeaders {
        func redact(_ s: String) -> String
        func filterHeaders(_ h: [String: String]) -> [String: String]
    }

    public struct NoOpRedactor: RedactingHeaders {
        public init() {}
        public func redact(_ s: String) -> String { s }
        public func filterHeaders(_ h: [String: String]) -> [String: String] { h }
    }

    public let redactor: RedactingHeaders
    /// Session Vitals (iOS spec 2026-09-05 §2): the running collector's session id + recent
    /// ring; nil when vitals are off. `stamp()` is the 100 ms-bounded read, safe on the crash path.
    let vitalsStamp: @Sendable () -> VitalsStamp?
    /// `vitalsStartEpoch` is the start epoch the REPORT was captured under
    /// (`TXCapturedSession.user.startEpoch`), not a live read. Vitals are stamped only while
    /// that session is still the installed one; a superseding `start()` degrades the envelope
    /// to no vitals rather than stamping the next project's session id and timeline (codex
    /// round-1, Critical 1 — the same "lose data, never misroute it" rule `resolve()` follows).
    /// Passing nil means "no session to bind to", which in production stamps nothing.
    public init(redactor: RedactingHeaders = NoOpRedactor(), vitalsStartEpoch: Int? = nil) {
        self.init(redactor: redactor, vitalsStamp: { VitalsRuntime.shared.stamp(forStartEpoch: vitalsStartEpoch) })
    }
    init(redactor: RedactingHeaders = NoOpRedactor(), vitalsStamp: @escaping @Sendable () -> VitalsStamp?) {
        self.redactor = redactor; self.vitalsStamp = vitalsStamp
    }

    /// One log entry as it lands in the envelope JSON. `timestamp` is the per-entry
    /// capture time; the builder serializes it as ISO-8601. `tag` is optional —
    /// always nil on iOS, present for Timber-sourced lines on Android. Mirrored on
    /// the wire so backend consumers see a single uniform shape.
    public struct LogRow {
        public let timestamp: Date
        public let level: String
        public let tag: String?
        public let message: String

        public init(timestamp: Date, level: String, tag: String? = nil, message: String) {
            self.timestamp = timestamp
            self.level = level
            self.tag = tag
            self.message = message
        }
    }

    public struct NetworkRow {
        public let method: String
        public let url: String
        public let status: Int?
        public let durationMs: Double?
        public let requestHeaders: [String: String]
        public let responseHeaders: [String: String]

        public init(
            method: String,
            url: String,
            status: Int?,
            durationMs: Double?,
            requestHeaders: [String: String],
            responseHeaders: [String: String]
        ) {
            self.method = method
            self.url = url
            self.status = status
            self.durationMs = durationMs
            self.requestHeaders = requestHeaders
            self.responseHeaders = responseHeaders
        }
    }

    /// Max total characters of captured-log messages shipped in an envelope.
    static let maxLogChars = 4000

    /// Trim captured logs to the most recent rows that fit within `maxChars`
    /// total message characters; everything older collapses into ONE "REDACTED"
    /// marker at the front. The newest row is always kept (truncated if it alone
    /// exceeds the budget) so we never emit zero logs.
    ///
    /// Mirrors sdk-core's `trimLogs` (TypeScript) and Android's
    /// `EnvelopeBuilder.trimLogs` (Kotlin) — keep the three in lockstep.
    static func trimLogs(_ logs: [LogRow], maxChars: Int = maxLogChars) -> [LogRow] {
        if logs.isEmpty { return [] }
        var kept: [LogRow] = []
        var total = 0
        var i = logs.count - 1
        while i >= 0 {
            let row = logs[i]
            let len = row.message.count
            if kept.isEmpty {
                if len > maxChars {
                    kept.append(LogRow(timestamp: row.timestamp, level: row.level, tag: row.tag,
                                       message: String(row.message.prefix(maxChars))))
                    total = maxChars
                } else {
                    kept.append(row)
                    total = len
                }
                i -= 1
                continue
            }
            if total + len > maxChars { break }
            kept.append(row)
            total += len
            i -= 1
        }
        kept.reverse()
        let dropped = logs.count - kept.count
        if dropped > 0 {
            let markerTs = logs[dropped - 1].timestamp
            kept.insert(LogRow(timestamp: markerTs, level: "info", tag: nil, message: "REDACTED"), at: 0)
        }
        return kept
    }

    public func buildEncoded(
        reportId: UUID,
        sdkName: String = "traceitx-ios",
        sdkVersion: String,
        logs: [LogRow] = [],
        networkRows: [NetworkRow] = [],
        attachments: [Attachment] = [],
        /// Structured per-shape annotation entries (Task 10 —
        /// `AnnotationWireFormat.serialize(...).annotations`, concatenated
        /// across every shot by the caller). nil/empty → `payload.annotations`
        /// omitted from the envelope.
        annotations: [JSONAny]? = nil,
        /// Blur-shape mirror (`AnnotationWireFormat.serialize(...).redactions`).
        /// nil/empty → `payload.redactions` omitted.
        redactions: [JSONAny]? = nil,
        extra: [String: String] = [:],
        /// Host-supplied opaque metadata string (`Payload.extra`). Distinct
        /// from the `extra:` dict above, which is a typed-mapping side-channel
        /// for `reporter.title`, `context.device.*`, etc. `userExtra` lands
        /// in `payload.extra` verbatim.
        userExtra: String? = nil,
        /// Trimmed breadcrumb chain (spec §4) for `payload.breadcrumbs`. The
        /// caller (ReporterSubmission) supplies the frozen ring-buffer
        /// snapshot; nil/empty ships an envelope byte-identical to the
        /// pre-breadcrumbs builder — `Captures.breadcrumbs` still comes back
        /// `false` and `captureControl.included` is untouched. Trim options
        /// default to the Task-3 constants ("from live config, defaulted" —
        /// no config-threading plumbing added here for v1).
        breadcrumbs: [Breadcrumb]? = nil,
        breadcrumbByteBudget: Int = BreadcrumbTrim.byteBudget,
        breadcrumbConsoleEntryCap: Int = BreadcrumbTrim.consoleEntryCap,
        /// Envelope-level discriminator (spec 2026-07-18): `nil` for a manual
        /// reporter-driven report (pre-crash-reporting wire shape, `source`
        /// omitted); `.crash`/`.error` for automatic crash/error reports
        /// (Task 13).
        source: ReportEnvelopeSource? = nil,
        /// `payload.crash` — populated only for automatic crash reports.
        crash: Crash? = nil,
        /// Frozen network-body ring-buffer snapshot (spec network-body-capture)
        /// for `payload.networkBodies`. Bodies arrive HERE ALREADY REDACTED —
        /// NetworkBodyCapture redacts at add-time (mask-before-bytes), same
        /// posture as breadcrumbs above — so this builder does NOT run them
        /// through `redactor` again. nil/empty → field omitted, same
        /// no-op-when-absent contract as `breadcrumbs`.
        networkBodies: [NetworkBody]? = nil,
        /// Report Resource Window (spec 2026-09-05) — CPU/memory samples for
        /// `payload.resources`. Same no-op-when-absent contract as
        /// `breadcrumbs`/`networkBodies` above: nil/empty ships an envelope
        /// byte-identical to the pre-resources builder. Capped at
        /// `ResourceRingBuffer.maxSamples`, keeping the NEWEST entries — the
        /// ring itself is already capped, but re-applying the cap here (like
        /// the trim helpers above) keeps this call site from drifting apart
        /// from the ring's own limit; a stamp exceeding the server's cap
        /// rejects the WHOLE report, non-retryably.
        resources: [ResourceSample]? = nil
    ) throws -> (bytes: Data, idempotencyKey: String) {
        let redactedLogs = Self.trimLogs(logs.map {
            LogRow(timestamp: $0.timestamp, level: $0.level, tag: $0.tag, message: redactor.redact($0.message))
        })
        let redactedNetwork = networkRows.map { row in
            NetworkRow(
                method: row.method,
                url: redactor.redact(row.url),
                status: row.status,
                durationMs: row.durationMs,
                requestHeaders: redactor.filterHeaders(row.requestHeaders),
                responseHeaders: redactor.filterHeaders(row.responseHeaders)
            )
        }

        // Breadcrumbs already passed through mask-before-bytes redaction at
        // add-time (BreadcrumbRingBuffer) — no redactor pass here, mirrors
        // sdk-core/Android (trim is the only transform left before the wire).
        let trimmedBreadcrumbs: [Breadcrumb]? = (breadcrumbs?.isEmpty == false)
            ? BreadcrumbTrim.trim(breadcrumbs!, byteBudget: breadcrumbByteBudget, consoleEntryCap: breadcrumbConsoleEntryCap)
            : nil

        // Invariant (network-body-capture spec §11 test 8, inherited from the
        // web spec): every shipped `payload.networkBodies[].ref` must match
        // exactly one shipped `kind == network` crumb's `data.reqId`. Body
        // capture and breadcrumb capture are gated/evicted independently
        // upstream (breadcrumbs may be off or `kinds` may omit `network`; the
        // body ring and the crumb ring trim on unrelated budgets) — so a body
        // can outlive the crumb that gave it request context. Filter HERE,
        // at the encode boundary where both channels converge and AFTER
        // breadcrumb trimming has produced the final shipped chain, down to
        // the reqIds that actually made it onto the wire. A body without a
        // shipped crumb carries no request context for the reporter/backend,
        // so it must never upload — crumbs are the side that's authoritative
        // here and are never mutated to "rescue" an orphaned body.
        let shippedNetworkReqIds: Set<Double> = Set(
            (trimmedBreadcrumbs ?? []).compactMap { crumb -> Double? in
                guard crumb.kind == .network else { return nil }
                return Self.reqId(from: crumb.data)
            }
        )
        let filteredNetworkBodies = networkBodies?.filter { shippedNetworkReqIds.contains($0.ref) }
        let bodiesForPayload: [NetworkBody]? = (filteredNetworkBodies?.isEmpty == false) ? filteredNetworkBodies : nil

        // Re-cap at the encode boundary, keeping the NEWEST samples — same
        // doctrine as the network-body filter above: never trust an upstream
        // caller (or a future ring-buffer bug) to have already enforced the
        // limit the SERVER enforces, since exceeding it drops the WHOLE
        // report rather than merely this field.
        let cappedResources: [ResourceSample]? = {
            guard let resources, !resources.isEmpty else { return nil }
            return resources.count > ResourceRingBuffer.maxSamples
                ? Array(resources.suffix(ResourceRingBuffer.maxSamples))
                : resources
        }()
        // Vitals stamp — a bounded copy of the recent ring; a failure degrades to "no
        // vitals", never to a lost report. `sessionId` and `payload.vitals` are stamped
        // independently: a running collector with an empty ring still stamps the id.
        let stamp = dispatch("envelope.vitalsStamp") { vitalsStamp() } ?? nil
        let vitalsGenerated: [Vital]? = stamp.map { Array($0.entries.suffix(VitalsLimits.maxEnvelopeVitalsEntries)).toGeneratedVitals() }.flatMap { $0.isEmpty ? nil : $0 }

        let envelope = try Self.composeEnvelope(
            reportId: reportId,
            sdkName: sdkName,
            sdkVersion: sdkVersion,
            redactedLogs: redactedLogs,
            redactedNetwork: redactedNetwork,
            attachments: attachments,
            annotations: (annotations?.isEmpty == true) ? nil : annotations,
            redactions: (redactions?.isEmpty == true) ? nil : redactions,
            extra: extra,
            userExtra: userExtra,
            trimmedBreadcrumbs: trimmedBreadcrumbs,
            source: source,
            crash: crash,
            networkBodies: bodiesForPayload,
            resources: cappedResources,
            vitalsGenerated: vitalsGenerated,
            sessionId: stamp?.sessionId
        )

        let bytes = try Self.makeJSONEncoder().encode(envelope)

        guard bytes.count <= Self.SIZE_CAP_BYTES else {
            throw TraceItXTransportError.payloadTooLarge(bytes: bytes.count, limit: Self.SIZE_CAP_BYTES)
        }

        let digest = SHA256.hash(data: bytes)
        let hex = digest.compactMap { String(format: "%02x", $0) }.joined()
        return (bytes, hex)
    }

    /// Shared wire-byte authority for envelope and bounded optional details.
    static func makeJSONEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    /// Concrete envelope composition — NOT a fixture passthrough. Function
    /// arguments are propagated into the returned envelope using
    /// Generated.swift's synthesized memberwise initializer.
    ///
    /// Field-name source: `swift/Sources/TraceItXProtocol/Generated.swift`
    /// (quicktype output as of plan 04-01). See `04-01-SUMMARY.md` for the
    /// exact field list this body was filled against.
    ///
    /// Known scope-limit (plan 04-02 closes):
    /// * `Generated.SDK.name` enum currently lacks `traceitx-ios`. Plan 04-02
    ///   extends the protocol package's `name` enum and updates this site to
    ///   use `Name.traceitxIOS`. For now the placeholder is `.traceitxReact`
    ///   and the `sdkName: String` argument is preserved verbatim in the
    ///   returned envelope's `reporter.description` (so it round-trips through
    ///   tests and is not silently dropped).
    private static func composeEnvelope(
        reportId: UUID,
        sdkName: String,
        sdkVersion: String,
        redactedLogs: [LogRow],
        redactedNetwork: [NetworkRow],
        attachments: [Attachment],
        annotations: [JSONAny]?,
        redactions: [JSONAny]?,
        extra: [String: String],
        userExtra: String?,
        trimmedBreadcrumbs: [Breadcrumb]?,
        source: ReportEnvelopeSource?,
        crash: Crash?,
        networkBodies: [NetworkBody]?,
        resources: [ResourceSample]?,
        vitalsGenerated: [Vital]?,
        sessionId: String?
    ) throws -> ReportEnvelope {
        let now = Date()

        // Encode logs/network as `[JSONAny]?` via JSON round-trip — Generated.swift
        // exposes them as opaque arrays because the schema declares
        // `array<unknown>`. Plan 04-02 lands typed log/network shapes when the
        // protocol package adds them.
        // ISO-8601 with millisecond precision so JS-side timestamps merge cleanly
        // when the RN bridge starts shipping `console.*` entries (see backlog).
        let isoFormatter: ISO8601DateFormatter = {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return f
        }()
        let logsJSON: [JSONAny]? = try redactedLogs.isEmpty ? nil : Self.toJSONAnyArray(
            redactedLogs.map { row -> [String: Any] in
                var dict: [String: Any] = [
                    "timestamp": isoFormatter.string(from: row.timestamp),
                    "level": row.level,
                    "message": row.message,
                ]
                if let tag = row.tag { dict["tag"] = tag }
                return dict
            }
        )
        let networkJSON: [JSONAny]? = try redactedNetwork.isEmpty ? nil : Self.toJSONAnyArray(
            redactedNetwork.map { row -> [String: Any] in
                var dict: [String: Any] = [
                    "method": row.method,
                    "url": row.url,
                    "requestHeaders": row.requestHeaders,
                    "responseHeaders": row.responseHeaders,
                ]
                if let status = row.status { dict["status"] = status }
                if let durationMs = row.durationMs { dict["durationMs"] = durationMs }
                return dict
            }
        )
        // `ResourceSample` (Capture layer) is `Codable` in its own right, so —
        // unlike logs/network above, which start life as plain Swift rows —
        // this goes straight through `JSONEncoder`/`JSONDecoder` rather than
        // a hand-built `[String: Any]`. That is deliberate: it is what
        // actually exercises (and lets a test ASSERT, not merely assume)
        // `JSONEncoder`'s default behaviour of OMITTING a nil `Optional`
        // rather than encoding an explicit `null` — the schema's `cpu` is
        // `.optional()`, and an explicit null fails validation and drops the
        // WHOLE report. `Payload.resources` is now a generated, typed
        // `[Resource]?` (envelope.v1.schema.json regenerated to include the
        // resources block) — `ResourceSample` still lives in the
        // higher-level Capture module (TraceItXKit) and can't be referenced
        // directly from `Payload` (TraceItXProtocol), so this still goes
        // through a JSON round trip, just decoding into the generated
        // `Resource` type instead of an opaque `JSONAny`.
        let resourcesJSON: [Resource]? = try (resources?.isEmpty ?? true) ? nil : {
            let data = try JSONEncoder().encode(resources!)
            return try JSONDecoder().decode([Resource].self, from: data)
        }()

        // Map sdkName argument to the protocol enum. As of 04-02 the protocol
        // enum has been extended to include `traceitx-ios` (and `traceitx-android`
        // for Phase-5 readiness) so the placeholder branch from 04-01 is gone:
        // every supported SDK name has a direct enum case. Unknown names fall
        // back to `.traceitxIos` and the literal value is preserved in
        // `reporter.description` for traceability.
        let nameEnum: Name = Name(rawValue: sdkName) ?? .traceitxIos
        let title = extra["title"] ?? ""
        let descriptionText: String = {
            let supplied = extra["description"] ?? ""
            if nameEnum.rawValue != sdkName {
                let marker = "[sdk.name=\(sdkName)]"
                return supplied.isEmpty ? marker : "\(supplied) \(marker)"
            }
            return supplied
        }()

        let user: User? = {
            guard let id = extra["user.id"] ?? extra["user.email"] ?? extra["user.displayName"] else { return nil }
            _ = id
            return User(displayName: extra["user.displayName"], email: extra["user.email"], id: extra["user.id"])
        }()

        let reporter = Reporter(description: descriptionText, title: title, user: user)

        // Tap-to-identify and UI-tree capture were removed entirely (spec
        // 2026-08-29): nothing on this platform walks a view hierarchy for the
        // envelope any more, so `payload.uiTree`, `payload.reactTree` and
        // `payload.reportTarget` are always absent.
        //
        // `captures.uiTree` is NOT dropped with them. The protocol schema
        // declares it a REQUIRED boolean, so omitting the key fails envelope
        // validation at ingest — it stays, hardcoded `false`, exactly as
        // `buildEnvelope` in sdk-core does on the JS side.

        let captures = Captures(
            breadcrumbs: trimmedBreadcrumbs != nil,
            focus: false,
            logs: !redactedLogs.isEmpty,
            network: !redactedNetwork.isEmpty,
            screenshot: false,
            uiTree: false
        )

        var includedCaptures: [String] = []
        if trimmedBreadcrumbs != nil { includedCaptures.append("breadcrumbs") }
        if let bodies = networkBodies, !bodies.isEmpty { includedCaptures.append("networkBodies") }

        let captureControl = CaptureControl(
            degradedReason: extra["captureControl.degradedReason"],
            excluded: [],
            included: includedCaptures
        )

        let payload = Payload(
            annotations: annotations,
            breadcrumbs: trimmedBreadcrumbs,
            // Crash/error reporting (spec 2026-07-18): nil for manual reporter
            // reports; populated by CrashReporter (Task 13) for automatic
            // crash/error reports.
            crash: crash,
            extra: userExtra,
            focus: nil,
            logs: logsJSON,
            network: networkJSON,
            networkBodies: (networkBodies?.isEmpty == false) ? networkBodies : nil,
            redactions: redactions,
            resources: resourcesJSON,
            vitals: vitalsGenerated
        )

        // App + device come from extras at this scaffold layer. Plan 04-02 wires
        // real `Bundle.main` / `UIDevice.current` / `UIScreen.main` plumbing.
        #if canImport(Foundation)
        let bundleName = Bundle.main.bundleIdentifier ?? "unknown"
        let bundleVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
        let bundleBuild = Bundle.main.infoDictionary?["CFBundleVersion"] as? String
        #else
        let bundleName = "unknown"
        let bundleVersion = "0.0.0"
        let bundleBuild: String? = nil
        #endif

        let app = App(
            build: extra["app.build"] ?? bundleBuild,
            name: extra["app.name"] ?? bundleName,
            version: extra["app.version"] ?? bundleVersion
        )
        let device = Device(
            locale: extra["device.locale"] ?? Locale.current.identifier,
            model: extra["device.model"],
            os: extra["device.os"] ?? "iOS",
            osVersion: extra["device.osVersion"] ?? "0.0",
            pixelRatio: Double(extra["device.pixelRatio"] ?? "1.0") ?? 1.0,
            screenSize: ScreenSize(
                height: Double(extra["device.screen.height"] ?? "0") ?? 0,
                width: Double(extra["device.screen.width"] ?? "0") ?? 0
            ),
            timezone: extra["device.timezone"] ?? TimeZone.current.identifier,
            // userAgent is a web-only concept (reporter SPA captures
            // navigator.userAgent); native iOS has no equivalent so the
            // protocol field is optional and we leave it nil here.
            userAgent: extra["device.userAgent"]
        )
        let context = Context(app: app, device: device, route: extra["route"])

        #if os(tvOS)
        let defaultPlatform: Platform = .tvos
        let defaultFormFactor: FormFactor = .tv
        #else
        let defaultPlatform: Platform = .ios
        let defaultFormFactor: FormFactor = .phone
        #endif

        return ReportEnvelope(
            attachments: attachments,
            captureControl: captureControl,
            captures: captures,
            context: context,
            payload: payload,
            protocolVersion: ProtocolVersion.the10,
            reporter: reporter,
            reportID: reportId.uuidString,
            sdk: SDK(
                formFactor: FormFactor(rawValue: extra["sdk.formFactor"] ?? "") ?? defaultFormFactor,
                name: nameEnum,
                platform: Platform(rawValue: extra["sdk.platform"] ?? "") ?? defaultPlatform,
                version: sdkVersion
            ),
            // Session Vitals (iOS spec 2026-09-05 §2): the running collector's session id;
            // nil when vitals are off. Stamped independently of `payload.vitals` — a running
            // collector with an empty ring still stamps the id.
            sessionID: sessionId,
            // nil (== 'manual') for a manual reporter report; `.crash`/`.error`
            // for automatic crash/error reports (Task 13's CrashReporter).
            source: source,
            submittedAt: now
        )
    }

    /// Extract a network crumb's `data.reqId` as a `Double`, tolerant of
    /// `JSONAny`'s decode order (integral values decode as `Int64`, not
    /// `Double` — see `NetworkBodyCaptureTests.dualWriteAddsReqIdOnlyWhenProvided`
    /// / `CrossSDKProto02Tests`, which read numeric `data` values via
    /// `.value as? Int64`). `NetworkBody.ref` is generated as `Double` (minted
    /// from the same `Int` reqId via `Double(reqId)`), so normalizing both
    /// sides to `Double` here lets the encode-boundary filter compare them
    /// directly. Returns `nil` when the key is absent or not numeric.
    private static func reqId(from crumbData: [String: JSONAny]?) -> Double? {
        guard let raw = crumbData?["reqId"]?.value else { return nil }
        if let i = raw as? Int64 { return Double(i) }
        if let d = raw as? Double { return d }
        return nil
    }

    /// Encode a `[ [String: Any] ]` payload through JSON to obtain a
    /// `[JSONAny]` decodable by quicktype's generated wrapper. Used for
    /// payload.logs/network where the schema declares `array<unknown>`.
    private static func toJSONAnyArray(_ rows: [[String: Any]]) throws -> [JSONAny] {
        let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
        return try JSONDecoder().decode([JSONAny].self, from: data)
    }
}
