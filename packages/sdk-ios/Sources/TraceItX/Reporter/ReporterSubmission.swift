// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ReporterSubmission — shared envelope-build + submit pipeline used by the
// iOS/iPadOS reporter (ReporterViewController) AND the phone-companion path
// (CompanionCaptureBridge). Same SDK, same protocol → must produce
// byte-identical wire envelopes regardless of which front-end produced the
// inputs. The ingest service has one schema and one parser; it does not
// care which surface the user tapped Send on.
//
// Historical: the tvOS modal reporter (now removed) previously hand-rolled a
// placeholder JSON envelope (`{"reportId":"…","title":"tvOS report","description":""}`),
// which the ingest service rejected because it skipped EnvelopeBuilder and
// therefore omitted the protocol-required fields (sdkName, sdkVersion,
// captures, device metadata, attachments[].sha256, etc.). Extracting this
// helper makes the two view controllers share the canonical path.
//
// Platform differences (parameterised, not branched):
//   • iOS exposes a DetailsDisclosure with per-section include/exclude
//     toggles — pass the resolved booleans (`includeLogs`, `includeNetwork`,
//     `includeMetadata`). User-typed `title` + `description` come from the
//     form fields.
//   • tvOS has no toggles UI (focus-engine + scrolling toggles is hostile on
//     TV) and no text fields (text input on Siri Remote is brutal). Pass
//     all-`true` flags + empty `title` and `description`.
//
// Capture timing invariant: `captureResult` MUST already have been
// captured BEFORE the reporter window was constructed (T-04-24,
// capture-before-reporter ordering). This helper does not capture; it only
// composes + uploads.

#if canImport(UIKit)
import Foundation
import UIKit
import CryptoKit
import TraceItXProtocol

// NOTE: Moved from TraceItXReporterUI → TraceItX in Plan 06.2-12 so that
// `CompanionCaptureBridge` (which lives in TraceItX and cannot reach into the
// higher-layer ReporterUI module) can compose the SAME envelope+submit
// pipeline used by the in-process iOS/tvOS reporter VCs. Module direction
// makes "promote internal → public" insufficient — the file itself must live
// in the lower module so both callsites can reach it. Behaviour is otherwise
// unchanged; see SUMMARY.md "Deviations" for rationale.

@MainActor
public enum ReporterSubmission {

    /// Hard cap on title length — matches the Zod protocol schema and every
    /// other reporter UI (web, phone-companion SPA, Android Compose, iOS UIKit).
    public static let titleMaxChars: Int = 200
    /// Hard cap on description length — see `titleMaxChars`.
    public static let descriptionMaxChars: Int = 600

    /// Inputs for one report submission. Aggregated into a struct so the
    /// callsite is self-documenting and so adding a future field (e.g.
    /// user-attached files) doesn't ripple through the function signature.
    public struct Inputs {
        // Authorizes only shared capture consumption, not delivery of already
        // received report content. Pair loss must not discard a submitted report.
        internal var captureIsCurrent: @MainActor @Sendable () -> Bool = { true }
        /// One screenshot part of a multi-shot submission (Task 10).
        /// ReporterUI (upper module) bakes annotations onto `image` and
        /// serializes them into `annotationsJSON`/`redactionsJSON` BEFORE
        /// constructing this — `Shot` never carries the `Annotation` model
        /// type (which lives one module up and is invisible from here).
        public struct Shot {
            public let image: UIImage
            /// This shot's wire-serialized annotation entries (every shape,
            /// `AnnotationWireFormat.serialize(...).annotations`). Concatenated
            /// with every other shot's entries into `payload.annotations`.
            public let annotationsJSON: [JSONAny]
            /// This shot's blur-shape mirror (`AnnotationWireFormat.serialize(...).redactions`).
            /// Concatenated into `payload.redactions`.
            public let redactionsJSON: [JSONAny]
            /// True when this shot has ≥1 annotation — selects the attachment's
            /// `AttachmentKind` (`.annotatedScreenshot` vs `.screenshot`) and,
            /// via `partName(kind:index:)`, the wire kind-string baked into its
            /// part name.
            public let annotated: Bool

            public init(
                image: UIImage,
                annotationsJSON: [JSONAny] = [],
                redactionsJSON: [JSONAny] = [],
                annotated: Bool
            ) {
                self.image = image
                self.annotationsJSON = annotationsJSON
                self.redactionsJSON = redactionsJSON
                self.annotated = annotated
            }
        }

        public let captureResult: ScreenshotCapture.Result
        /// One or more screenshot parts (Task 10 — multi-shot). Shot 0 is
        /// the reporter's open-time auto-capture (or the sole shot on the
        /// companion path, which has no annotation UI of its own). Order is
        /// wire order: `partName(kind:index:)` derives each part's name
        /// from its index here.
        public let shots: [Shot]
        public let title: String
        public let description: String
        /// When false, `LogRingBuffer.shared.snapshot()` is skipped.
        public let includeLogs: Bool
        /// When false, `NetworkRingBuffer.shared.snapshot()` is skipped.
        public let includeNetwork: Bool
        /// When false, `device.*` keys are not added to envelope.extra.
        public let includeMetadata: Bool
        /// Caller-supplied extra keys merged into envelope.extra AFTER the
        /// helper's own keys — e.g. a `captureControl.degradedReason` marker.
        /// Empty for callers with nothing to add.
        public let extraOverrides: [String: String]
        /// Host-attached opaque metadata string. Consumed from
        /// TraceItX.shared.setExtra(...) at presenter open-time and passed
        /// through here (NOT consumed inside submit). nil → no payload.extra.
        public let hostExtra: String?
        /**
         Self-declared user (`setUser`, spec 2026-08-12) SNAPSHOTTED at the
         moment this report's submission began — the Send tap for the in-app
         reporter, the paired submit+binary frames for the companion.

         External review, finding 3 (Serious). `submit(_:)` used to read the
         live singleton's user inline, deep inside asynchronous
         envelope assembly. Everything between the user pressing Send and that
         read — the `Task` hop, per-shot annotation baking, image encoding,
         SHA-256, replay serialization, multipart construction — can span
         hundreds of milliseconds to seconds, and a `setUser` call landing in
         that window (a sign-out/sign-in, an account switch) permanently
         grouped A's report under B.

         Deliberately has NO default, exactly like `companionAttribution`
         above and for the identical reason: every caller must state who this
         report belongs to. A default of "read the live singleton" is the
         precise defect this field exists to prevent, and a default of `nil`
         would let a new submit surface silently ship anonymous.

         This is the native counterpart of web's
         `captureUserSnapshot` / `ReporterCompletePayload.capturedUser` — same
         defect, same remedy, same boundary. `TXUser` is a value type, so
         holding it here is already a snapshot; nothing can mutate it later.

         External review, finding 1 (Serious) — the snapshot carries the
         SESSION it was taken in, not a bare `TXUser?`. The
         user was snapshotted at the Send tap but `cfg` — which carries the SDK
         key, i.e. the destination PROJECT — is read below, asynchronously, so
         a `start(projectB)` landing in the gap uploaded A's user under B's
         key. `resolve()` returns the user only while its own session is still
         installed. See `TXCapturedUser.swift`'s file header.

         FOLLOW-UPS ITEM 9 — this is a `TXCapturedSession`, not a
         `TXCapturedUser`, and that difference is the whole fix. The epoch
         guard above solved the ATTRIBUTION half and left the DESTINATION
         half open: `submit` still read the LIVE singleton's config on
         the far side of the Send tap, so a `start(projectB)` landing in the
         window made `resolve()` correctly return `nil` — and the report then
         shipped to B anyway, carrying A's screenshot, UI tree, breadcrumbs
         and network rows. Anonymity is not a mitigation when the payload is
         the disclosure. Carrying the config in the same snapshot removes the
         second read entirely, and the `killGeneration` it also carries is what
         `submit` re-checks at the submit boundary.
         */
        public let capturedSession: TXCapturedSession
        /// Companion attribution token (spec 2026-08-07), supplied ONLY by
        /// `CompanionCaptureBridge` for a dashboard-initiated report. Sent as
        /// the `X-TX-Companion-Attribution` header on the ingest POST; it
        /// never enters the envelope. nil for every in-app reporter submit.
        /// SECURITY: never log.
        public let companionAttribution: String?

        public init(
            captureResult: ScreenshotCapture.Result,
            shots: [Shot],
            title: String,
            description: String,
            includeLogs: Bool,
            includeNetwork: Bool,
            includeMetadata: Bool,
            extraOverrides: [String: String],
            hostExtra: String?,
            capturedSession: TXCapturedSession,
            companionAttribution: String? = nil
        ) {
            self.captureResult = captureResult
            self.shots = shots
            // Defense-in-depth: clamp to the Zod protocol caps even if a caller
            // (programmatic submit, future surface) sends longer strings than
            // the UI inputs allow. Counts characters, not UTF-16 units, so an
            // emoji-padded title can't sneak past `String.count`.
            // Self.* inside Inputs would resolve to Inputs — the constants live
            // one scope up on ReporterSubmission. Spell the parent type out.
            self.title = String(title.prefix(ReporterSubmission.titleMaxChars))
            self.description = String(description.prefix(ReporterSubmission.descriptionMaxChars))
            self.includeLogs = includeLogs
            self.includeNetwork = includeNetwork
            self.includeMetadata = includeMetadata
            self.extraOverrides = extraOverrides
            self.hostExtra = hostExtra
            self.capturedSession = capturedSession
            self.companionAttribution = companionAttribution
        }
    }

    /// Wire part name for shot `index` of kind `kind` ("screenshot" or
    /// "annotated-screenshot"). Shot 1 (index 0) keeps the bare kind name
    /// for backward wire compatibility with the pre-multi-shot single
    /// attachment; shots 2+ get a 1-based `-N` suffix (second shot → `-2`,
    /// matching web). `nonisolated` — pure string formatting, no actor
    /// state — so it's callable from a plain synchronous test function
    /// despite `ReporterSubmission` being `@MainActor`.
    nonisolated static func partName(kind: String, index: Int) -> String {
        index == 0 ? kind : "\(kind)-\(index + 1)"
    }

    /// Pure helper (network-free, hence unit-testable): for each shot's
    /// annotated flag, pick its `AttachmentKind` and derive its part name.
    /// `submit(_:)` zips this plan against `inputs.shots` to build the real
    /// (byte-carrying) attachments.
    nonisolated static func buildAttachmentPlan(
        annotatedFlags: [Bool]
    ) -> [(partName: String, kind: AttachmentKind)] {
        annotatedFlags.enumerated().map { index, annotated in
            let kind: AttachmentKind = annotated ? .annotatedScreenshot : .screenshot
            return (partName: partName(kind: kind.rawValue, index: index), kind: kind)
        }
    }

    /// Test-only seam (follow-ups item 9) — `nil` in production, where
    /// `submit` always builds its own `ReportSubmitter`.
    ///
    /// It exists because this function has no injection point for the
    /// submitter and no test may reach the real ingest endpoint. That is not
    /// a stylistic preference: register item 7 was a suite POSTing to
    /// production, and `makeIsolatedSession()` deliberately strips only
    /// `TXNetworkCaptureProtocol`, so a `URLProtocol` stub is not a dependable
    /// lever here either. The remaining alternative — pointing
    /// `TRACEITX_DEV_INGEST_URL` at an unroutable host — needs CI env plumbing
    /// and is resolved once per process into a `static let`, so a suite could
    /// not set it for itself.
    ///
    /// The seam also witnesses exactly what item 9 is about: WHICH CONFIG the
    /// submitter was constructed with. Same pattern as
    /// `__replaySessionFactoryForTesting`, `__bodyStateResetHookForTesting`
    /// and `__afterUserSnapshotHookForTesting`.
    nonisolated(unsafe) internal static var __submitterFactoryForTesting: ((TraceItXConfig) -> ReportSubmitter)?

    /// Reset the seam — call from `tearDown`; the property is process-global.
    internal static func __resetSubmitterFactoryForTesting() {
        __submitterFactoryForTesting = nil
    }

    /// Build the canonical envelope from `inputs`, attach the baked PNG, and
    /// submit through `ReportSubmitter`. Returns the same `ReportResult` the
    /// caller would have returned to its `onComplete`.
    ///
    /// Throws `ReporterSubmissionError.notStarted` if `TraceItX.shared.start(...)`
    /// was never called (no `currentConfig`). Throws transport errors
    /// (`TraceItXTransportError`) on terminal failures; transient errors land
    /// in the outbox and resolve as `ReportResult.queued(...)` per the
    /// existing `ReportSubmitter.submit(...)` contract.
    public static func submit(_ inputs: Inputs) async throws -> ReportResult {
        // FOLLOW-UPS ITEM 9 — the config comes from the snapshot taken at the
        // Send tap, NOT from a live `TraceItX.shared.currentConfig` read here.
        //
        // `_config` carries the SDK KEY, i.e. the project every byte of this
        // report is uploaded to, and everything between the tap and this line
        // — the `Task` hop, per-shot annotation baking, image encoding,
        // SHA-256, replay gzip, multipart construction — runs for hundreds of
        // milliseconds to seconds. A `start(projectB)` landing in that window
        // used to repoint the whole upload at B while the payload was still
        // A's screenshot, UI tree, breadcrumbs and network rows.
        //
        // The epoch guard below (`capturedSession.user.resolve()`) never
        // covered this: it protected the ATTRIBUTION and degraded the user to
        // anonymous, which reads like a mitigation and is not one — an
        // anonymous screenshot of project A's app in project B's inbox is the
        // same disclosure. Item 6 fixed the identical read on the crash path;
        // this is that fix on the path with the far wider payload and a window
        // measured in seconds of deliberate human action rather than the
        // microseconds of a crash unwind.
        guard let cfg = inputs.capturedSession.config else {
            throw ReporterSubmissionError.notStarted
        }

        // FOLLOW-UPS ITEM 9, SECOND ROUND (external review 2026-08-13, codex).
        // The two reads below are the only ones in this function that touch a
        // LIVE process-global buffer; everything else either comes from
        // `inputs` or from a snapshot frozen at reporter-open. Pinning the
        // config above fixed the direction that mattered — A's report reaching
        // B — and opened a narrower one in reverse: if a `start(B)` landed
        // between the Send tap and this line, these two buffers now hold rows
        // captured under B, and they would ship under A's key.
        //
        // So drop them when the session has moved on. NOT the whole report:
        // the screenshot, UI tree and frozen breadcrumbs/bodies are all still
        // legitimately A's, and a report that reaches its project missing two
        // sections beats one that never arrives. Same doctrine as `resolve()`
        // degrading the user to anonymous — lose data, never misroute it.
        //
        // Note this drops A's OWN rows too, since `LogRingBuffer` is cleared
        // by neither `start()` nor `kill()` (unlike the breadcrumb, network
        // and body rings, which item 10 taught `start()` to zeroize) so its
        // contents after a switch are A's and B's interleaved with no way to
        // tell them apart here. That log-buffer asymmetry is recorded
        // separately in the follow-ups register; this line is deliberately
        // conservative about it rather than waiting for it.
        let ownsInitialCapture = !inputs.capturedSession.isSuperseded && inputs.captureIsCurrent()
        let logEntries = (inputs.includeLogs && ownsInitialCapture) ? LogRingBuffer.shared.snapshot() : []
        let netEntries = (inputs.includeNetwork && ownsInitialCapture) ? NetworkRingBuffer.shared.snapshot() : []
        // NETWORK BODIES (network-body-capture spec): bodies ride the SAME
        // includeNetwork toggle as network metadata — one user-facing
        // "network" switch controls both channels. include → takeFrozen()
        // (freeze() was called at reporter-open, __replayFreeze below /
        // CompanionCaptureBridge); exclude → discardAndResume() so the live
        // buffer resumes capturing rather than sitting frozen forever, and
        // nil ships (no payload.networkBodies, no captureControl marker).
        let frozenBodies: [NetworkBody]?
        if !ownsInitialCapture {
            // FOLLOW-UPS ITEM 9, THIRD ROUND (external review 2026-08-13,
            // codex). The frozen snapshot is process-global and unkeyed, so
            // once a `start(B)` has cleared it a report opened UNDER B can
            // freeze its own content into the same slot before this line runs.
            // Consuming it here would upload B's bodies under A's key.
            //
            // Touch NEITHER `takeFrozen()` NOR `discardAndResume()`: both
            // clear the slot, and doing that would steal the snapshot from the
            // B report that legitimately owns it — trading a disclosure for a
            // silent data loss in the other project. Leave it alone entirely
            // and ship without bodies.
            frozenBodies = nil
        } else if inputs.includeNetwork {
            frozenBodies = NetworkBodyRingBuffer.shared.takeFrozen()
        } else {
            NetworkBodyRingBuffer.shared.discardAndResume()
            frozenBodies = nil
        }
        let device = DeviceMetadata.snapshot()
        let logRows = logEntries.map {
            EnvelopeBuilder.LogRow(timestamp: $0.timestamp, level: $0.level, tag: nil, message: $0.message)
        }
        let networkRows = netEntries.map { e in
            EnvelopeBuilder.NetworkRow(
                method: e.method,
                url: e.url,
                status: e.status,
                durationMs: e.durationMs,
                requestHeaders: e.requestHeaders,
                responseHeaders: e.responseHeaders
            )
        }

        var extra: [String: String] = [
            "title": inputs.title,
            "description": inputs.description,
        ]
        if inputs.includeMetadata {
            extra["device.model"] = device.model
            extra["device.os"] = "\(device.osName) \(device.osVersion)"
            extra["device.osVersion"] = device.osVersion
            extra["device.locale"] = device.locale
            extra["device.timezone"] = device.timezone
            extra["device.screen.width"] = String(device.screenWidth)
            extra["device.screen.height"] = String(device.screenHeight)
            extra["device.pixelRatio"] = String(device.pixelRatio)
            if let v = device.appVersion { extra["app.version"] = v }
            if let b = device.appBuild { extra["app.build"] = b }
            if let id = device.bundleIdentifier { extra["app.bundleId"] = id }
        }

        // Self-declared identity (spec 2026-08-12). EnvelopeBuilder reads these
        // three keys back into `reporter.user`. Emitted regardless of
        // `includeMetadata`: that toggle governs DEVICE metadata, whereas the
        // user is a host-set attribution the reporter never sees a toggle for.
        // Before this spec `setUser` stored `_user` and nothing ever read it.
        //
        // External review, finding 3 (Serious) — read from `inputs`, NEVER
        // from `TraceItX.shared.currentUser`. This function is `async` and
        // everything above it (the caller's `Task` hop, annotation baking,
        // image encoding, hashing) can run for seconds after the user tapped
        // Send; a live read here attributed A's report to whoever `setUser`
        // named by the time it executed. `Inputs.capturedSession` is snapshotted
        // at the true submit boundary by each caller — the same treatment
        // `companionAttribution` already gets, and the native counterpart of
        // web's `captureUserSnapshot`.
        //
        // External review, finding 1 (Serious) — `resolve()`, not the raw
        // snapshot. `cfg` above carries the SDK key, i.e. the PROJECT this
        // envelope is uploaded to, and it is read here, asynchronously, long
        // after the Send tap that captured the user. A `start(projectB)` in
        // that gap left the captured user perfectly intact (the live singleton
        // is cleared by `start()`, the snapshot is not) and would have shipped
        // A's id/email/display name under B's key. `resolve()` returns the
        // user only while the session it was captured in is still the
        // installed one, and `nil` — anonymous — otherwise.
        //
        // ORDERING IS LOAD-BEARING: this must stay AFTER the `cfg` read at the
        // top of this function. The epoch increases monotonically, so a
        // matching epoch here proves no `start()`/`kill()` ran between the
        // capture and now — which covers the moment `cfg` was read, making
        // `cfg` this same session's config. Resolving BEFORE reading `cfg`
        // would reopen the exact window this closes.
        if let user = inputs.capturedSession.user.resolve() {
            if let id = user.id { extra["user.id"] = id }
            if let email = user.email { extra["user.email"] = email }
            if let displayName = user.displayName { extra["user.displayName"] = displayName }
        }

        // DEFE-02 soft-degrade: caller decides via extraOverrides. Both the
        // in-app reporter and the companion path currently pass an empty dict.
        for (key, value) in inputs.extraOverrides {
            extra[key] = value
        }

        // Host-attached sticky payload is consumed at presenter open-time
        // (TXReporterPresenter.openAndAwait), shown in the modal so the user
        // can toggle inclusion, then threaded through Inputs. No drain here —
        // a second consume would also drop sticky data for non-presenter
        // callers (tests, future programmatic submit paths).
        let userExtra = inputs.hostExtra

        // MULTI-SHOT ATTACHMENTS (Task 10): one PNG/JPEG multipart part +
        // envelope Attachment PER SHOT. `buildAttachmentPlan` derives each
        // shot's AttachmentKind (annotated iff that shot carries ≥1
        // annotation) and part name (shot 1 bare, shots 2+ "-N", N =
        // 1-based index) from a pure [Bool] — zipped here against the real
        // (byte-carrying) shots to build the actual attachments. Each
        // shot's already-serialized (by ReporterUI, upper module)
        // annotationsJSON/redactionsJSON concatenate into the envelope's
        // payload.annotations/payload.redactions.
        let plan = Self.buildAttachmentPlan(annotatedFlags: inputs.shots.map(\.annotated))
        var envelopeAttachments: [Attachment] = []
        var multipartAttachments: [ReportSubmitter.Attachment] = []
        var allAnnotationsJSON: [JSONAny] = []
        var allRedactionsJSON: [JSONAny] = []

        for (index, shot) in inputs.shots.enumerated() {
            // Encode each shot's baked image for the wire + object storage.
            // JPEG @ q=0.85 is the storage win (~50-60% byte reduction vs
            // PNG with no visible loss for screenshot content); falls back
            // to PNG when JPEG isn't smaller (rare — e.g. solid-color
            // screenshots) so we never spend more bytes than the source.
            let (bytes, mime, ext) = encodeBakedImageForStorage(shot.image)
            let sha = SHA256.hash(data: bytes).compactMap { String(format: "%02x", $0) }.joined()
            let part = plan[index]

            envelopeAttachments.append(Attachment(
                byteLength: Double(bytes.count),
                contentType: mime,
                durationMS: nil,   // screenshot carries no replay duration
                format: nil,       // session-replay format applies to the vtree blob only (Phase 22-04)
                height: nil,
                kind: part.kind,
                partName: part.partName,
                sha256: sha,
                width: nil
            ))
            multipartAttachments.append(ReportSubmitter.Attachment(
                name: part.partName,
                filename: "\(part.partName).\(ext)",
                contentType: mime,
                data: bytes,
                sha256Hex: sha
            ))
            allAnnotationsJSON.append(contentsOf: shot.annotationsJSON)
            allRedactionsJSON.append(contentsOf: shot.redactionsJSON)
        }

        // Resolve the current session once, before awaiting finalization. A
        // superseded report must never consume the next session's recording.
        let replayClaim = !inputs.capturedSession.isSuperseded && inputs.captureIsCurrent()
            ? await TraceItX.shared.__replayCompleteVideo() : nil
        let artifact = replayClaim?.artifact
        let replayPart: ReplayPart?
        if let artifact, replayClaim?.isValid == true, !inputs.capturedSession.isSuperseded, inputs.captureIsCurrent() {
            replayPart = await buildReplayAttachment(artifact: artifact,
                byteBudget: 25_000_000 - multipartAttachments.reduce(0) { $0 + $1.data.count })
        } else {
            artifact?.removeOwnedFile()
            replayPart = nil
        }

        if let replayPart = replayPart, replayClaim?.isValid == true, !inputs.capturedSession.isSuperseded, inputs.captureIsCurrent() {
            envelopeAttachments.append(replayPart.envelope)
            multipartAttachments.append(replayPart.multipart)
        } else if artifact != nil || !inputs.captureIsCurrent() {
            extra["captureControl.degradedReason"] = replayClaim?.isValid == true && inputs.captureIsCurrent() ? "replay_omitted" : "replay_revoked"
        } else if let reason = replayClaim?.omissionReason {
            extra["captureControl.degradedReason"] = reason
        }

        // Session Vitals (codex round-1, Critical 1) — the stamp is bound to the epoch this
        // report was CAPTURED under, exactly like the frozen replay/breadcrumb slots above:
        // a `start(B)` between the Send tap and this assembly must not put B's session id and
        // B's playback timeline into A's envelope. Bound, not `isSuperseded`-gated, because
        // the runtime resolves the epoch atomically with the controller it selects.
        let builder = EnvelopeBuilder(vitalsStartEpoch: inputs.capturedSession.user.startEpoch)
        // BREADCRUMBS (Task 6): consume the frozen chain snapshotted at
        // reporter-open in TXReporterPresenter, or at report.request in
        // CompanionCaptureBridge.beginReportCaptureLifecycle (__replayFreeze →
        // BreadcrumbRingBuffer.freeze(), same lifecycle as the replay timeline
        // above). takeFrozen() never throws
        // and returning nil (freeze() never called, or an empty chain) is a
        // normal, fail-soft path — the envelope simply ships without
        // payload.breadcrumbs. Resumes a fresh buffer for the next report.
        // SAFETY: BreadcrumbRingBuffer.freeze()/discardAndResume()/takeFrozen()
        // are non-throwing by design; if the buffer ever gains a throwing
        // path, wrap this call in its own guard so breadcrumbs can never
        // block the replay seam or a report.
        // FOLLOW-UPS ITEM 9, THIRD ROUND — same rule as the bodies above: once
        // the session has moved on, the frozen chain in this process-global
        // slot may belong to a report opened under the NEW project. Do not
        // consume it (that would ship B's crumbs under A's key) and do not
        // clear it (that would steal it from B's own report).
        let frozenBreadcrumbs = !inputs.capturedSession.isSuperseded && inputs.captureIsCurrent()
            ? BreadcrumbRingBuffer.shared.takeFrozen() : nil
        let reportId = UUID()
        func encodeEnvelope() throws -> Data {
            try builder.buildEncoded(
            reportId: reportId,
            sdkName: "traceitx-ios",
            sdkVersion: TraceItX.SDK_VERSION,
            logs: logRows,
            networkRows: networkRows,
            attachments: envelopeAttachments,
            annotations: allAnnotationsJSON,
            redactions: allRedactionsJSON,
            extra: extra,
            userExtra: userExtra,
            breadcrumbs: frozenBreadcrumbs,
            networkBodies: frozenBodies,
            // Report Resource Window (spec 2026-09-05, fix round 1 CRITICAL 1)
            // — the user-submitted bug-report path is the feature's PRIMARY
            // use case, and this call site shipped `resources: nil` by
            // omission (only CrashReporter.swift stamped it). Live snapshot,
            // same as the crash path — there is no freeze/takeFrozen
            // lifecycle for resources (unlike breadcrumbs/bodies above), so
            // a plain `.snapshot()` read is the whole fix.
            resources: ResourceRingBuffer.shared.snapshot()
            ).0
        }
        var envelopeBytes = try encodeEnvelope()
        // Receiver counts all part payloads, including the JSON envelope.
        // Remove optional video before sending, never lose the actual report.
        if let reason = NativeVideoReportBudget.omissionReason(envelopeBytes: envelopeBytes.count,
            attachmentBytes: multipartAttachments.map(\.data.count)),
           multipartAttachments.contains(where: { $0.name == "replay" }) {
            multipartAttachments.removeAll { $0.name == "replay" }
            envelopeAttachments.removeAll { $0.partName == "replay" }
            extra["captureControl.degradedReason"] = reason
            envelopeBytes = try encodeEnvelope()
        }

        // FOLLOW-UPS ITEM 9 — re-check revocation HERE, at the submit
        // boundary, and deliberately NOT immediately before the outbox write
        // the way the crash path does it (`CrashReporter.captureFacts`).
        //
        // That difference is not cosmetic and copying the crash path's shape
        // literally would produce a fix that looks right and does nothing. On
        // the crash path the outbox write IS the delivery — the process is
        // dying, persisting is all that happens, so a check immediately before
        // it is a check immediately before delivery. Here it is the other way
        // round: `ReportSubmitter.submit` UPLOADS LIVE FIRST and enqueues only
        // when `RetryPolicy.classify` calls the failure retryable. A check
        // placed before the write would therefore run only on the FAILURE
        // path, and a revoked report that uploaded successfully — the case
        // that actually matters — would be POSTed with no check at all.
        //
        // A monotonic counter, not `captureGate`: `start()` re-opens that gate,
        // so a boolean check would wave through exactly the
        // `kill()` → `start()` sequence this is here to stop.
        if inputs.capturedSession.isRevoked {
            throw ReporterSubmissionError.revoked
        }

        // Native identity Task 8b — the live submit boundary. Resolve the
        // `X-TX-Identity-Token` value HERE, against the subject captured at
        // the Send tap (`inputs.capturedSession.user.identitySubject`, NOT a
        // live `TraceItX.shared._identityHolder.cachedSubject(...)` read —
        // the same capture-time-not-submit-time rule
        // `capturedSession.user.resolve()` already enforces for the
        // self-declared user, for the identical reason: an identity change
        // landing in the seconds/minutes this function can run for must not
        // repoint an in-flight report). `resolveIdentityHeader` itself is
        // what refuses the header on any subject mismatch.
        //
        // Merge note (native-identity x captured-session): `inputs.capturedUser`
        // was renamed to `inputs.capturedSession` (follow-ups item 9) — the
        // identity subject rides the SAME `TXCapturedSession.user` field the
        // self-declared-user resolution above already reads, not a second,
        // independently-captured value. The epoch comparisons below are
        // otherwise UNCHANGED from the original native-identity fix.
        //
        // Final whole-branch review, Important 2 — a subject match alone is
        // NOT enough: `sub` is the host's own user id, typically unchanged
        // across a tenant or dev/prod switch, so `start(projectB)` landing
        // in this window (a host that just switched user or tenant plausibly
        // calls `setIdentityToken` again immediately) could let this report
        // present project B's live token while everything else about it —
        // envelope, `cfg` above — still belongs to project A. The correction
        // above ("no separate epoch check is needed … `start()`/`kill()`
        // already clear `_identityHolder`") only holds until the host calls
        // `setIdentityToken` again, which is exactly what a host that just
        // reconfigured plausibly does. Re-check the epoch here, the same way
        // `inputs.capturedSession.user.resolve()` does above for the
        // self-declared user: a mismatch means a superseding `start()`/
        // `kill()` ran since the Send tap, and this report must ship with no
        // header at all, regardless of what the live holder/config say now.
        //
        // Independent review, Serious 1 — the check above alone is a TOCTOU
        // window: `resolveIdentityHeader` below is `async` and its OWN await
        // points (`holder.get(now:)`'s provider re-ask can take up to
        // `IDENTITY_PROVIDER_TIMEOUT`) give a `start(projectB)` +
        // `setIdentityToken(B)` landing DURING resolution — after the
        // pre-check above already passed — a window to land: `_identityHolder`
        // is one persistent object whose CONTENTS `set()` mutates in place, so
        // a token installed mid-resolution is exactly what `holder.get(now:)`
        // can return, resolving project B's live bearer credential onto a
        // report whose envelope/`cfg` still belong to project A, if B's `sub`
        // happens to match (plausible — see above). `_startEpoch` increases
        // monotonically and is bumped synchronously and unconditionally by
        // BOTH `start()` and `kill()`, so re-reading it AFTER resolution
        // completes, immediately before the result is ever used, closes this
        // exactly the same way the pre-check closes the window before
        // resolution starts: any `start()`/`kill()` anywhere in the whole
        // window — before OR during resolution — leaves a mismatch here.
        // Independent review, P1 — `capturedEpochStillCurrent` below governs
        // BOTH `identityToken` and the PERSISTED `identitySubject` handed to
        // `submit(...)` — computed once, used for both, so the two decisions
        // cannot drift apart. Before this fix, an epoch mismatch correctly
        // withheld `identityToken` for the LIVE attempt but still persisted
        // the raw captured subject onto a queued `OutboxEntry` on transient
        // failure — inconsistent with `capturedSession.user.resolve()` above,
        // which already drops the self-declared user on the identical
        // mismatch. A later drain could then attach a header on the strength
        // of a subject the SDK had already concluded it should not rely on.
        let identityToken: String?
        let capturedEpochStillCurrent: Bool
        if inputs.capturedSession.user.startEpoch == TraceItX.shared.currentStartEpoch {
            let resolved = await resolveIdentityHeader(
                capturedSubject: inputs.capturedSession.user.identitySubject,
                holder: TraceItX.shared._identityHolder,
                config: await TraceItX.shared.currentReplayConfig(),
                now: Date()
            )
            capturedEpochStillCurrent = inputs.capturedSession.user.startEpoch == TraceItX.shared.currentStartEpoch
            // Independent review, round 15, Serious — re-check enablement on
            // a FRESH config read too, not just the epoch: `resolveIdentityHeader`'s
            // own suspension (the holder's provider re-ask, up to
            // `IDENTITY_PROVIDER_TIMEOUT`) gives a remote config change that
            // flips `identity.enabled` OFF — WITHOUT bumping the epoch (only
            // `start()`/`kill()` do that) — a window to land during
            // resolution, so `resolveIdentityHeader` decided against a config
            // snapshot that was already stale by the time it returned.
            // Mirrors `ReportSubmitter.drainOutbox`'s own identical guard
            // exactly (`let stillEnabled = isIdentityEnabled(await
            // currentReplayConfig())`), so the live and drain paths cannot
            // drift. Deliberately kept OUT of `capturedEpochStillCurrent`
            // itself — that value also gates whether `identitySubject` is
            // trustworthy enough to PERSIST on a retry (below), a question
            // purely about project/session identity via the epoch; a live
            // enablement flip with no project switch at all does not make
            // the captured snapshot itself untrustworthy, only today's TOKEN
            // decision.
            let stillEnabled = isIdentityEnabled(await TraceItX.shared.currentReplayConfig())
            identityToken = (capturedEpochStillCurrent && stillEnabled) ? resolved : nil
        } else {
            capturedEpochStillCurrent = false
            identityToken = nil
        }

        let submitter = Self.__submitterFactoryForTesting?(cfg) ?? ReportSubmitter(config: cfg)
        // All asynchronous packing and identity resolution is now complete.
        // Config-off, lifecycle invalidation, restart and kill revoke a claim
        // even after the movie was consumed into multipart Data. Never revive
        // that claim if capture is subsequently enabled again.
        if inputs.capturedSession.isRevoked { throw ReporterSubmissionError.revoked }
        if replayClaim?.isValid == false || !inputs.captureIsCurrent(), multipartAttachments.contains(where: { $0.name == "replay" }) {
            multipartAttachments.removeAll { $0.name == "replay" }
            envelopeAttachments.removeAll { $0.partName == "replay" }
            extra["captureControl.degradedReason"] = "replay_revoked"
            envelopeBytes = try encodeEnvelope()
        }
        let hasReplay = multipartAttachments.contains(where: { $0.name == "replay" })
        let capturedSession = inputs.capturedSession
        let authorizedSubmitter = submitter.authorizing {
            !capturedSession.isRevoked && (!hasReplay || (replayClaim?.isValid == true && inputs.captureIsCurrent()))
        }
        let idempotencyKey = UUID().uuidString
        func send(using sender: ReportSubmitter) async throws -> ReportResult {
            try await sender.submit(
            envelopeBytes: envelopeBytes,
            idempotencyKey: idempotencyKey,
            attachments: multipartAttachments,
            // Companion-only; nil (and therefore header-less) on every
            // in-app reporter submit. SECURITY: never log.
            companionAttribution: inputs.companionAttribution,
            identitySubject: capturedEpochStillCurrent ? inputs.capturedSession.user.identitySubject : nil,
            identityToken: identityToken
            )
        }
        do { return try await send(using: authorizedSubmitter) }
        catch UploadAuthorizationError.revoked {
            guard !capturedSession.isRevoked, hasReplay else { throw ReporterSubmissionError.revoked }
            // Authorization failed before URLSession started: retry the same
            // report once without optional replay, not through durable retry.
            multipartAttachments.removeAll { $0.name == "replay" }
            envelopeAttachments.removeAll { $0.partName == "replay" }
            extra["captureControl.degradedReason"] = "replay_revoked"
            envelopeBytes = try encodeEnvelope()
            let reportOnlySubmitter = submitter.authorizing { !capturedSession.isRevoked }
            do { return try await send(using: reportOnlySubmitter) }
            catch UploadAuthorizationError.revoked { throw ReporterSubmissionError.revoked }
        }
    }

    /// One assembled session-replay attachment: the envelope `Attachment` ref +
    /// the multipart `Part` carrying binary MP4 bytes.
    struct ReplayPart {
        let envelope: Attachment
        let multipart: ReportSubmitter.Attachment
    }

    /// Consumes one owned MP4. Read/hash work runs away from the reporter's
    /// main actor; malformed, missing or oversized media is omitted fail-soft.
    internal static func buildReplayAttachment(
        artifact: NativeVideoArtifact, byteBudget: Int
    ) async -> ReplayPart? {
        let packed = await Task.detached(priority: .utility) { () -> (Data, String)? in
            defer { artifact.removeOwnedFile() }
            guard artifact.byteCount > 0, artifact.byteCount <= min(8 * 1024 * 1024, byteBudget),
                  artifact.startEpochMs.isFinite, artifact.startEpochMs >= 0,
                  artifact.durationMs.isFinite, artifact.durationMs > 0, artifact.durationMs <= 30_000,
                  artifact.width > 0, artifact.height > 0,
                  let size = try? artifact.url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
                  size.isRegularFile == true, size.fileSize == artifact.byteCount,
                  let bytes = try? Data(contentsOf: artifact.url), bytes.count == artifact.byteCount else { return nil }
            let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            return (bytes, sha)
        }.value
        guard let (bytes, sha) = packed else { return nil }
            return ReplayPart(envelope: Attachment(
                byteLength: Double(bytes.count), contentType: "video/mp4",
                durationMS: artifact.durationMs, format: .traceitxVideoV1,
                height: Double(artifact.height), kind: .sessionReplay, partName: "replay",
                replayStartEpochMS: artifact.startEpochMs, sha256: sha, width: Double(artifact.width)
            ), multipart: ReportSubmitter.Attachment(
                name: "replay", filename: "replay.mp4", contentType: "video/mp4", data: bytes, sha256Hex: sha
            ))
    }
}

public enum ReporterSubmissionError: Error {
    /// `TraceItX.shared.start(_:)` was never called. The caller (reporter VC)
    /// resolves this as `.cancelled` rather than throwing to the user — there
    /// is nothing the host can do about a misconfigured app.
    case notStarted

    /// A `kill()` landed between the Send tap and this submit (follow-ups
    /// item 9). Resolved by the caller exactly like `notStarted` — there is
    /// nothing the host or the user can do about a revoked session, and a
    /// revoked capture must not reach the network.
    ///
    /// Distinct from `notStarted` so the two are separable in a log or a
    /// future metric: one means the SDK was never configured, the other means
    /// a report was deliberately dropped.
    case revoked
}

#if canImport(UIKit)
/// Encode the baked annotated screenshot for the wire + object storage.
/// Tries JPEG @ q=0.85 first (~50-60% byte reduction vs PNG for typical
/// 1080p screenshots, no perceptible loss), falls back to PNG when JPEG
/// isn't actually smaller. Returns (bytes, mime, fileExtension) so the
/// envelope attachment + multipart filename stay consistent with the
/// actual encoder.
///
/// WebP would beat JPEG by another 20-30% but CGImageDestination's WebP
/// encoder is iOS 17+; our iOS floor is 15. Hosts that pin iOS 17+ can
/// opt-in via a future config flag — keep this function the sole entry
/// point so the swap stays localized.
private func encodeBakedImageForStorage(_ image: UIImage) -> (Data, String, String) {
    let png = image.pngData() ?? Data()
    if let jpeg = image.jpegData(compressionQuality: 0.85),
       jpeg.count < png.count
    {
        return (jpeg, "image/jpeg", "jpg")
    }
    return (png, "image/png", "png")
}
#endif

#endif
