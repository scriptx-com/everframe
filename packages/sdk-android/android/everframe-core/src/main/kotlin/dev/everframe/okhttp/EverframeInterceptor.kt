// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Opt-in OkHttp Interceptor. Per RESEARCH Finding 10 + CONTEXT D-03 — Everframe
// NEVER globally swizzles OkHttpClient and NEVER ships a managed OkHttpClient.
// The customer attaches the interceptor on a client THEY own, via the public
// extension `OkHttpClient.Builder.addEverframeInterceptor()` defined in
// `OkHttpExtensions.kt`. This closes the Android variant of Pitfall 3 (the
// Sentry/Bugsnag/Datadog/Firebase Performance interceptor-collision class
// of bugs).
//
// PRIV-03R hard invariant — body bytes are captured ONLY in the designated
// body-capture unit (the body path of `TXNetworkCaptureProtocol` on iOS;
// `capture/NetworkBodyTee.kt` on Android), ONLY behind the server-
// authoritative fail-closed gate, ALWAYS redacted before entering the body
// buffer. The metadata `Entry` structurally carries no body field.
//
// This file's own capture path records method, URL (post-redaction), status,
// duration in ms, and allowlisted/redacted headers ONLY; it never reads a
// payload stream itself. A request-direction implementation
// (`okhttp/NetworkBodyCapture.kt`) did briefly exist behind this same gate,
// but was removed 2026-08-02: a review showed its second
// write-side call is the same class of defect — `chain.proceed()` returning
// proves only that a FIRST write completed, not that a SECOND one (against an
// arbitrary, possibly stateful/slow, caller-supplied body; `isOneShot()`
// defaults to false) is prompt, and the byte ceiling that call was bounded by
// protects memory, not wall-clock time. Android therefore still ships NO
// request-direction body capture. The outgoing request is never touched here.
//
// Response direction (spec 2026-08-12-android-network-body-tee-design.md):
// wired below via `NetworkBodyTee`, the one file the acceptance-criteria
// source-grep gate permits to name the body tokens — this file, and every
// other file under `okhttp/`, must stay at zero matches for the dotted-
// property forms, so a reviewer can verify the boundary in one command. The
// tee delegates the read to the app FIRST and only ever copies bytes the app
// already pulled — it never pre-reads, so it cannot reintroduce the
// synchronous-read defect the old `Response.peekBody`-based implementation
// had. (The forbidden tokens intentionally do not appear in this file — not
// even in comments — so the grep stays green.)
//
// DEFE-03 kill switch — captureGate is read on the hot path. When the host
// has called Everframe.kill() the interceptor short-circuits to chain.proceed
// without recording or redacting; OkHttp call semantics are unaffected.
//
// Coexistence with other interceptors: this is a regular `Interceptor` (NOT a
// network interceptor). It runs in the application-interceptor chain and is
// transparent to the response — we do not buffer, decompress, decode, mutate,
// or re-issue. Bugsnag's BugsnagOkHttpPlugin / Sentry's SentryOkHttpInterceptor
// / Datadog's DatadogInterceptor all live in the same chain; ordering is
// determined by the customer's `addInterceptor` call order, which is exactly
// the locked behaviour per CONTEXT D-03.
package dev.everframe.okhttp

import dev.everframe.Everframe
import dev.everframe.capture.NetworkBodyCaptureState
import dev.everframe.capture.NetworkBodyFinalizer
import dev.everframe.capture.NetworkBodyTee
import dev.everframe.capture.NetworkBreadcrumbAdapter
import dev.everframe.capture.NetworkRingBuffer
import dev.everframe.capture.sharedNetworkBuffer
import dev.everframe.envelope.RedactionEngine
import okhttp3.Headers
import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

public class EverframeInterceptor internal constructor() : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val requestEpoch = Everframe.currentStartEpochVolatile()
        val req = chain.request()

        // DEFE-03 kill switch — pass-through when capture is gated off. We do
        // NOT redact, do NOT push to the ring buffer, and do NOT measure
        // duration: a kill()ed SDK is invisible.
        if (!Everframe.captureGate) return chain.proceed(req)

        val startNanos = System.nanoTime()
        val redactedUrl = RedactionEngine.redact(req.url.toString())
        val reqHeaders = RedactionEngine.filterHeaders(req.headers.toFlatMap())

        return try {
            val resp = chain.proceed(req)
            // Snapshot body authority BEFORE checking the originating request epoch. A snapshot
            // from a replacement session is rejected here; a later replacement is rejected by
            // the body's existing generation check at finalization.
            val snap = NetworkBodyCaptureState.snapshotActive()
            // Round-2 review Finding F11 — chain.proceed() can block long
            // enough (a slow/streaming response) for kill() to land mid-flight:
            // it flips captureGate AND zeroizes sharedNetworkBuffer.
            // Re-check HERE, before any push / dualWrite below, so a killed
            // SDK records nothing post-proceed — the call itself still
            // completes normally to the app either way (DEFE-03: capture
            // failure never affects the response handed back to the caller).
            // The ring buffer itself also gates on Everframe.captureGate
            // (honorsKillGate, default true) as the authoritative backstop
            // against the check-then-act race between this line and the
            // actual push.
            if (!Everframe.captureGate || Everframe.currentStartEpochVolatile() != requestEpoch) return resp
            val durMs = (System.nanoTime() - startNanos) / 1_000_000L
            val respHeaders = RedactionEngine.filterHeaders(resp.headers.toFlatMap())
            val entry = NetworkRingBuffer.Entry(
                timestamp = System.currentTimeMillis(),
                method = req.method,
                url = redactedUrl,
                status = resp.code,
                durationMs = durMs,
                requestHeaders = reqHeaders,
                responseHeaders = respHeaders,
                errorMessage = null,
            )
            // Body capture (spec 2026-08-12). The gate is snapshotted ONCE,
            // together with its generation, so the append boundary can
            // re-validate this exact decision later. A reqId is minted only
            // when an entry will actually be produced.
            val decision = if (snap.active) {
                NetworkBodyTee.decide(resp, NetworkBodyCaptureState.bodyContentTypes)
            } else {
                NetworkBodyTee.Decision.None
            }
            val reqId = if (decision is NetworkBodyTee.Decision.None) {
                null
            } else {
                NetworkBodyCaptureState.mintReqId()
            }

            sharedNetworkBuffer.push(entry, requestEpoch)
            // Task 11 dual-write — passive, gated by sharedBreadcrumbBuffer
            // itself. On Android `reqId` means "a body entry MAY exist for
            // this request": the crumb is written when proceed() returns, but
            // a teed body does not exist until the app finishes reading. The
            // encode-time filter only drops bodies without crumbs, never the
            // reverse, so a dangling reqId costs nothing.
            NetworkBreadcrumbAdapter.dualWrite(entry, reqId, requestEpoch)

            when (decision) {
                is NetworkBodyTee.Decision.None -> resp
                is NetworkBodyTee.Decision.Skip -> {
                    NetworkBodyFinalizer.appendSkip(
                        decision.reason,
                        bodyCtx(reqId!!, entry, snap.generation, respHeaders),
                    )
                    resp
                }
                is NetworkBodyTee.Decision.Capture ->
                    NetworkBodyTee.attach(resp, bodyCtx(reqId!!, entry, snap.generation, respHeaders))
            }
        } catch (e: IOException) {
            // Round-2 review Finding F11 — same re-check as the success path
            // above: chain.proceed() can throw well after kill() landed
            // (e.g. the connection was torn down mid-read after a kill()-
            // triggered teardown elsewhere), so this catch must also refuse
            // to record before re-throwing.
            if (!Everframe.captureGate || Everframe.currentStartEpochVolatile() != requestEpoch) throw e
            // Record the failure (no status, no response headers) and re-throw
            // so the caller's failure semantics are identical to a non-instrumented
            // chain — IOException IS the OkHttp contract for transport failure.
            val durMs = (System.nanoTime() - startNanos) / 1_000_000L
            val entry = NetworkRingBuffer.Entry(
                timestamp = System.currentTimeMillis(),
                method = req.method,
                url = redactedUrl,
                status = null,
                durationMs = durMs,
                requestHeaders = reqHeaders,
                responseHeaders = emptyMap(),
                errorMessage = e.message,
            )
            sharedNetworkBuffer.push(entry, requestEpoch)
            // Task 11 dual-write — passive, gated by sharedBreadcrumbBuffer itself.
            // Recorded BEFORE re-throw so the crumb lands even though the
            // caller's failure semantics (IOException propagation) are unchanged.
            NetworkBreadcrumbAdapter.dualWrite(entry, owner = requestEpoch)
            throw e
        }
    }
}

/**
 * Flatten OkHttp's multi-valued Headers into a single-value map. Multi-valued
 * headers (rare — Set-Cookie is the only common case, and Set-Cookie is not
 * on our allowlist anyway) collapse to a comma-joined string in line with
 * RFC 7230 §3.2.2. RedactionEngine.filterHeaders consumes a flat Map.
 */
private fun Headers.toFlatMap(): Map<String, String> {
    val map = LinkedHashMap<String, String>(size)
    for ((name, _) in this) {
        if (map.containsKey(name)) continue
        map[name] = values(name).joinToString(",")
    }
    return map
}

private fun bodyCtx(
    reqId: Int,
    entry: NetworkRingBuffer.Entry,
    generation: Int,
    respHeaders: Map<String, String>,
) = NetworkBodyFinalizer.Ctx(
    reqId = reqId,
    // The metadata entry's own timestamp — the single clock both channels
    // share, so oldest-first eviction sorts by response order.
    t = entry.timestamp,
    cap = NetworkBodyCaptureState.bodyByteCap,
    generation = generation,
    // Already redacted for the metadata entry; reused at zero cost.
    resHeaders = respHeaders,
)
