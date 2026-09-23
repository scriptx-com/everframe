// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PRIV-03 revised (network-body-capture spec §9): the ONLY iOS file allowed
// to read a request's outgoing body bytes. `EFNetworkCaptureProtocol`'s
// metadata path (NetworkCaptureProtocol.swift / NetworkRingBuffer.swift)
// stays body-free by construction — bodies are captured here, and ONLY here,
// strictly behind `NetworkBodyCaptureGate.isActive`, and are redacted BEFORE
// they ever reach `NetworkBodyRingBuffer` (never after — the buffer must
// never hold an un-redacted body, even transiently).
//
// Per-direction pipeline order (mirrors the Global Constraints redaction
// order exactly): content-type allowlist check -> bounded UTF-8-safe read
// (`utf8Prefix`, which itself performs the `cap`-bounded read) -> redact
// (`RedactionEngine.redact`) -> truncation flags -> caller buffers the
// result. `makeEntry` is pure and synchronous — no I/O, no shared state
// besides the injected `gate`/`engine` — so it is directly unit-testable
// against constructed `URLRequest`/`HTTPURLResponse` values, no live HTTP.
import Foundation
import EverframeProtocol

public enum NetworkBodyCapture {
    /// Builds a `EverframeNetworkBody` entry for one completed request, or `nil` when
    /// there is nothing to capture: the gate is inactive, or the request
    /// never produced a response (network failure/abort before headers
    /// arrived — nothing meaningful to correlate a body against).
    /// `reqHeaders`/`resHeaders` are the ALREADY-FILTERED maps produced by
    /// the metadata path (`RedactionEngine.filterHeaders`) — this function
    /// reads the content-type off THOSE maps rather than re-deriving it from
    /// the raw request/response, so the content-type gate itself only ever
    /// sees allowlisted header data.
    public static func makeEntry(
        reqId: Int,
        tEpochMs: Double,
        request: URLRequest,
        response: HTTPURLResponse?,
        responseData: Data?,
        reqHeaders: [String: String],
        resHeaders: [String: String],
        gate: NetworkBodyCaptureGate = .shared,
        engine: RedactionEngine = RedactionEngine()
    ) -> EverframeNetworkBody? {
        guard gate.isActive else { return nil }
        guard response != nil else { return nil }

        let cap = gate.bodyByteCap
        let allowlist = gate.bodyContentTypes

        let reqCapture = captureRequestBody(
            request: request,
            contentType: headerValue(reqHeaders, named: "content-type"),
            allowlist: allowlist, cap: cap, engine: engine)
        let resCapture = captureResponseBody(
            data: responseData,
            contentType: headerValue(resHeaders, named: "content-type"),
            allowlist: allowlist, cap: cap, engine: engine)

        return EverframeNetworkBody(
            ref: Double(reqId),
            reqBody: reqCapture.body,
            reqBodyBytes: reqCapture.bytes,
            reqBodySkipped: reqCapture.skipped,
            reqBodyTruncated: reqCapture.truncated,
            reqHeaders: reqHeaders,
            resBody: resCapture.body,
            resBodyBytes: resCapture.bytes,
            resBodySkipped: resCapture.skipped,
            resBodyTruncated: resCapture.truncated,
            resHeaders: resHeaders,
            t: tEpochMs
        )
    }

    /// Default-deny content-type allowlist match. Lowercases both sides,
    /// strips any `;`-delimited parameters (e.g. `; charset=utf-8`) off
    /// `contentType`, then matches either exactly or against a `prefix/*`
    /// wildcard entry in `allowlist`. A `nil` content type never matches.
    public static func contentTypeAllowed(_ contentType: String?, allowlist: [String]) -> Bool {
        guard let contentType else { return false }
        // `split(separator:maxSplits:)` OMITS empty subsequences by default,
        // so "" / ";" / ";;" all split down to an EMPTY array — indexing
        // `[0]` on that would crash. `.first` + guard makes the empty case a
        // normal (non-matching) fall-through instead of a crash.
        guard
            let base = contentType.split(separator: ";", maxSplits: 1).first
                .map({ $0.trimmingCharacters(in: .whitespaces).lowercased() }),
            !base.isEmpty
        else { return false }
        for entry in allowlist {
            let pattern = entry.lowercased()
            if pattern.hasSuffix("/*") {
                let prefix = pattern.dropLast() // keep the trailing "/"
                if base.hasPrefix(prefix) { return true }
            } else if base == pattern {
                return true
            }
        }
        return false
    }

    /// UTF-8 boundary-safe prefix of `data`, capped at `cap` bytes. Takes
    /// `data.prefix(cap)` and, if that slice ends mid-codepoint (decode
    /// fails), backs off up to 3 trailing bytes — the most a single UTF-8
    /// codepoint can straddle a cut — retrying the decode after each
    /// back-off. Returns `nil` only if no back-off (0...3 bytes dropped)
    /// yields valid UTF-8, i.e. the bytes aren't UTF-8 text at all.
    public static func utf8Prefix(_ data: Data, cap: Int) -> String? {
        guard cap >= 0 else { return nil }
        let boundedEnd = data.index(data.startIndex, offsetBy: min(cap, data.count))
        var end = boundedEnd
        var backoff = 0
        while true {
            if let decoded = String(data: data[data.startIndex..<end], encoding: .utf8) {
                return decoded
            }
            guard backoff < 3, end > data.startIndex else { return nil }
            end = data.index(before: end)
            backoff += 1
        }
    }

    // MARK: - Direction-specific capture

    private struct Capture<Skip> {
        let body: String?
        let bytes: Double?
        let skipped: Skip?
        let truncated: Bool?
    }

    /// Request-direction capture. Order: EXISTENCE check first (mirrors web
    /// parity — packages/sdk-react/src/capture/network.ts's
    /// `readRequestBody` checks whether a body is present before doing
    /// anything else; a body-less request, e.g. a plain GET, gets NO skip
    /// reason at all — there was nothing to skip) -> allowlist check (skip
    /// reason `.contentType`, only once we know a body actually exists) ->
    /// read (a stream-backed body with no in-memory bytes is `.unsupported`)
    /// -> bounded UTF-8 read -> redact -> truncation flags.
    private static func captureRequestBody(
        request: URLRequest, contentType: String?, allowlist: [String], cap: Int,
        engine: RedactionEngine
    ) -> Capture<EverframeBodySkipped> {
        let bodyData = request.httpBody
        guard bodyData != nil || request.httpBodyStream != nil else {
            return Capture(body: nil, bytes: nil, skipped: nil, truncated: nil)
        }
        guard contentTypeAllowed(contentType, allowlist: allowlist) else {
            return Capture(body: nil, bytes: nil, skipped: .contentType, truncated: nil)
        }
        guard let bodyData else {
            // Existence guard above already proved httpBodyStream != nil here.
            return Capture(body: nil, bytes: nil, skipped: .unsupported, truncated: nil)
        }
        return decodeAndRedact(bodyData, cap: cap, engine: engine, errorCase: .error)
    }

    /// Response-direction capture — same order as the request side, minus
    /// the stream case (`responseData` is already fully materialized bytes
    /// or `nil`, never a stream).
    private static func captureResponseBody(
        data: Data?, contentType: String?, allowlist: [String], cap: Int, engine: RedactionEngine
    ) -> Capture<EverframeBodySkipped> {
        guard contentTypeAllowed(contentType, allowlist: allowlist) else {
            return Capture(body: nil, bytes: nil, skipped: .contentType, truncated: nil)
        }
        guard let data else {
            return Capture(body: nil, bytes: nil, skipped: nil, truncated: nil)
        }
        return decodeAndRedact(data, cap: cap, engine: engine, errorCase: .error)
    }

    /// Final-review Finding 6 (cap-before-redaction leaks boundary-straddling
    /// secrets): extra bytes read PAST `cap`, purely for redaction-window
    /// purposes, so a secret (CC/SSN/JWT/bearer) starting just before the
    /// cap boundary is still fully present for the regexes to match instead
    /// of being cut mid-secret. See `decodeAndRedact` below for how this is
    /// used — the window is redacted FIRST, then truncated to `cap` on the
    /// REDACTED output, so plaintext is never truncated ahead of redaction.
    ///
    /// Residual risk (documented, not closed by this constant): a secret
    /// that starts within the first `cap` bytes but is itself longer than
    /// `cap + secretScanOverlap` bytes still straddles the WIDENED window's
    /// end and can leak a partial run. 4096 bytes is judged wide enough that
    /// no real-world secret shape here (credit card, SSN, JWT, bearer token)
    /// gets anywhere close to exhausting it from a start point inside the
    /// window.
    private static let secretScanOverlap = 4096

    /// Shared tail of both directions once content-type has cleared and raw
    /// bytes are in hand: bounded UTF-8-safe read OF A WIDENED WINDOW, redact
    /// that whole window, THEN truncate the REDACTED output down to `cap`
    /// (boundary-safe — a cut landing inside a `[REDACTED:...]` marker is
    /// harmless, since redaction already ran over the full window before any
    /// truncation happened). Truncation flag / `bytes` are computed off the
    /// ORIGINAL (pre-cap) byte count, unaffected by the wider scan window —
    /// see Finding 6 above for why the window is wider than `cap`.
    private static func decodeAndRedact<Skip>(
        _ data: Data, cap: Int, engine: RedactionEngine, errorCase: Skip
    ) -> Capture<Skip> {
        let originalBytes = data.count
        let windowEnd = min(originalBytes, cap + secretScanOverlap)
        guard let decodedWindow = utf8Prefix(data, cap: windowEnd) else {
            return Capture(body: nil, bytes: Double(originalBytes), skipped: errorCase, truncated: nil)
        }
        let redactedWindow = engine.redact(decodedWindow)
        let truncated = originalBytes > cap
        let body = truncated
            ? (utf8Prefix(Data(redactedWindow.utf8), cap: cap) ?? redactedWindow)
            : redactedWindow
        return Capture(
            body: body, bytes: Double(originalBytes), skipped: nil,
            truncated: truncated ? true : nil)
    }

    private static func headerValue(_ headers: [String: String], named name: String) -> String? {
        for (key, value) in headers where key.lowercased() == name {
            return value
        }
        return nil
    }
}
