// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Opt-in URLProtocol subclass. Per RESEARCH Finding 4 — never globally swizzles
// URLSession; customer assigns `networkCaptureConfiguration(base:)` to URLSessions
// they want captured. URLSession.shared is NEVER touched. Closes Pitfall 3
// (Sentry/Bugsnag/Datadog/Firebase Performance global-swizzle conflicts).
//
// Recursion guard: each request that enters startLoading() is tagged with
// "TXHandled" before being re-issued on a private inner session whose
// protocolClasses is empty — so the inner request cannot land back in our
// startLoading() and loop. canInit returns false for any request already
// carrying our tag.
//
// PRIV-03R hard invariant — body bytes are captured ONLY in the designated
// body-capture unit (the body path of `TXNetworkCaptureProtocol` on iOS;
// `capture/NetworkBodyTee.kt` on Android), ONLY behind the server-
// authoritative fail-closed gate, ALWAYS redacted before entering the body
// buffer. The metadata `Entry` structurally carries no body field.
//
// Concretely on iOS: the metadata entry (`NetworkLogEntry`) built below
// records method, URL (post-redaction), status, duration, and
// allowlisted/redacted headers — it still NEVER carries request or response
// body bytes. Bodies are captured separately, ONLY when
// `NetworkBodyCaptureGate` is active, via `NetworkBodyCapture` — which
// content-type-allowlists, bounds-reads, and redacts a body BEFORE it ever
// enters `NetworkBodyRingBuffer` (redaction always happens before buffering,
// never after). See NetworkBodyCapture.swift, the only file permitted to
// read outgoing request body bytes.
import Foundation

// `@unchecked Sendable` is sound here because URLProtocol semantics scope each
// instance to a single in-flight URL request: Foundation never invokes
// startLoading / stopLoading concurrently on the same instance, the dataTask
// completion runs serially, and mutable state (`session`, `inflightStart`) is
// written only inside that single-threaded lifecycle.
public final class TXNetworkCaptureProtocol: URLProtocol, @unchecked Sendable {

    private static let HANDLED_KEY = "TXHandled"
    private var inflightStart: Date = Date()
    private var session: URLSession?
    private var dataTask: URLSessionDataTask?

    public override class func canInit(with request: URLRequest) -> Bool {
        // Avoid recursion: only handle requests that haven't been tagged by us.
        if URLProtocol.property(forKey: HANDLED_KEY, in: request) != nil { return false }
        return true
    }

    public override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    public override func startLoading() {
        inflightStart = Date()
        let mutable = (request as NSURLRequest).mutableCopy() as! NSMutableURLRequest
        URLProtocol.setProperty(true, forKey: Self.HANDLED_KEY, in: mutable)

        // Use a private session — clear protocolClasses so our protocol is not
        // re-applied on the inner request (we are already inside our context).
        let cfg = URLSessionConfiguration.default
        cfg.protocolClasses = []
        let session = URLSession(configuration: cfg)
        self.session = session

        let req = mutable as URLRequest
        let task = session.dataTask(with: req) { [weak self] data, response, error in
            guard let self else { return }
            let durationMs = Date().timeIntervalSince(self.inflightStart) * 1000.0
            let engine = RedactionEngine()
            let entry = NetworkLogEntry(
                timestamp: self.inflightStart,
                method: req.httpMethod ?? "GET",
                url: engine.redact(req.url?.absoluteString ?? ""),
                status: (response as? HTTPURLResponse)?.statusCode,
                durationMs: durationMs,
                requestHeaders: engine.filterHeaders(req.allHTTPHeaderFields ?? [:]),
                responseHeaders: engine.filterHeaders(((response as? HTTPURLResponse)?.allHeaderFields as? [String: String]) ?? [:])
            )
            NetworkRingBuffer.shared.append(entry)

            // Body capture (spec network-body-capture, PRIV-03 revised) —
            // strictly behind the gate, and only when a response actually
            // arrived. `NetworkBodyCapture.makeEntry` redacts before this
            // ever reaches `NetworkBodyRingBuffer`.
            //
            // Final-review Finding 1 (post-kill capture): also check
            // `TraceItX.shared.captureGate` here, not just
            // `NetworkBodyCaptureGate.shared.isActive`. A request already
            // in flight when `kill()` fires completes on its own dataTask
            // callback, asynchronously, after `kill()` has returned — the
            // `captureGate` check catches that race even in the brief
            // window before `kill()`'s own gate-reset/buffer-guard defenses
            // (NetworkBodyCaptureGate.reset(), NetworkBodyRingBuffer's own
            // honorsKillGate check) take full effect.
            //
            // Round-7 review Finding F34: the decision to capture is made
            // HERE, via `snapshotActive()` — BEFORE `NetworkBodyCapture
            // .makeEntry` runs, which does real work (bounded reads,
            // redaction) that takes wall-clock time. Capturing `gateSnapshot
            // .generation` now and re-validating it (`isActive(forGeneration:)`)
            // atomically with the insert, inside `NetworkBodyRingBuffer
            // .append`'s own lock, is what makes a remote `captureBodies:
            // false` config refresh landing DURING `makeEntry` authoritative
            // at the actual sink boundary — previously only the pre-`makeEntry`
            // `isActive` read here was checked, and the buffer accepted
            // whatever `append` was later called with no matter how stale.
            var mintedReqId: Int? = nil
            let gateSnapshot = NetworkBodyCaptureGate.shared.snapshotActive()
            if TraceItX.shared.captureGate, gateSnapshot.active, response != nil {
                let reqId = NetworkBodyCaptureGate.shared.mintReqId()
                if let bodyEntry = NetworkBodyCapture.makeEntry(
                    reqId: reqId, tEpochMs: self.inflightStart.timeIntervalSince1970 * 1000,
                    request: req, response: response as? HTTPURLResponse, responseData: data,
                    reqHeaders: entry.requestHeaders, resHeaders: entry.responseHeaders) {
                    NetworkBodyRingBuffer.shared.append(bodyEntry) {
                        NetworkBodyCaptureGate.shared.isActive(forGeneration: gateSnapshot.generation)
                    }
                    mintedReqId = reqId
                }
            }

            // Task 7: breadcrumb dual-write. `entry.url` is already
            // redacted (RedactionEngine, above). `reqId` links this crumb to
            // the just-buffered body entry (nil when no body was captured).
            NetworkBreadcrumbAdapter.dualWrite(entry: entry, reqId: mintedReqId)

            // Forward to URLProtocol client so the host's URLSession progresses.
            if let response {
                self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            }
            if let data {
                self.client?.urlProtocol(self, didLoad: data)
            }
            if let error {
                self.client?.urlProtocol(self, didFailWithError: error)
            } else {
                self.client?.urlProtocolDidFinishLoading(self)
            }
        }
        self.dataTask = task
        task.resume()
    }

    public override func stopLoading() {
        dataTask?.cancel()
    }
}

public extension TraceItX {
    /// Returns a URLSessionConfiguration that captures network through TraceItX.
    /// Customer assigns this to `URLSession(configuration:)` for sessions they
    /// want captured — NEVER to URLSession.shared. Per RESEARCH Finding 4 this
    /// is the ONLY supported integration path; we do not, and will never, do
    /// global URLSession swizzling.
    func networkCaptureConfiguration(base: URLSessionConfiguration = .default) -> URLSessionConfiguration {
        let cfg = base.copy() as! URLSessionConfiguration
        var protos = cfg.protocolClasses ?? []
        protos.insert(TXNetworkCaptureProtocol.self, at: 0)
        cfg.protocolClasses = protos
        return cfg
    }
}
