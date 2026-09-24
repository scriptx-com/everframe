// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// PRIV-03R designated body-capture unit (Android). Body bytes are captured
// ONLY in this file, ONLY behind the server-authoritative fail-closed gate
// (NetworkBodyCaptureState), and are ALWAYS redacted before entering
// sharedNetworkBodyBuffer. The metadata Entry structurally carries no body
// field. This is the one file the acceptance-criteria source-grep gate
// permits to name the body tokens; okhttp/ must stay at zero matches.
//
// Spec: the public behavior contract
package dev.everframe.capture

import dev.everframe.Everframe
import dev.everframe.protocol.generated.BodySkipped
import okhttp3.MediaType
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.Source
import okio.buffer
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.concurrent.atomic.AtomicBoolean

object NetworkBodyTee {

    /** Widened scan window past `bodyByteCap` so a secret straddling the cap
     *  is still redacted before truncation (web F19 / iOS secretScanOverlap).
     *
     *  `internal` per spec §5.1: `everframe-core` publishes as `dev.everframe:core`
     *  and `proguard-rules.pro`'s blanket `-keep class dev.everframe.capture.**`
     *  would otherwise ship this whole file as callable AAR API that is
     *  expensive to retract later. Nothing outside this Gradle module needs it —
     *  `okhttp/` and `capture/` are the same module, so the interceptor and the
     *  tests keep compiling unchanged. */
    internal const val secretScanOverlap: Int = 4096

    /**
     * Kotlin port of iOS `NetworkBodyCapture.contentTypeAllowed`
     * (packages/sdk-ios/Sources/Everframe/Capture/NetworkBodyCapture.swift:78).
     * Compares the media type only — parameters after `;` are ignored — and
     * supports a trailing wildcard subtype (a slash followed by an asterisk,
     * e.g. `text` + wildcard). Degenerate inputs ("", ";", ";;")
     * fall through to false rather than crashing, which is the edge case iOS
     * review caught.
     */
    internal fun contentTypeAllowed(contentType: String?, allowlist: List<String>): Boolean {
        if (contentType == null) return false
        val base = contentType.substringBefore(';').trim().lowercase()
        if (base.isEmpty()) return false
        for (entry in allowlist) {
            val pattern = entry.lowercase()
            if (pattern.endsWith("/*")) {
                // dropLast(1) removes only the "*", keeping the "/" so
                // "text/*" cannot match "textual/plain".
                if (base.startsWith(pattern.dropLast(1))) return true
            } else if (base == pattern) {
                return true
            }
        }
        return false
    }

    /**
     * UTF-8 boundary-safe prefix of [data], capped at [cap] bytes. Backs off
     * up to 3 trailing bytes — the most a single UTF-8 codepoint can straddle
     * a cut — retrying a STRICT decode after each back-off. Returns null only
     * if no back-off yields valid UTF-8, i.e. the bytes are not UTF-8 text.
     * Mirrors iOS `utf8Prefix`.
     */
    internal fun utf8Prefix(data: ByteArray, cap: Int): String? {
        val end = minOf(cap, data.size)
        if (end < 0) return null
        for (backoff in 0..3) {
            val len = end - backoff
            if (len < 0) break
            decodeStrictUtf8(data, len)?.let { return it }
        }
        return null
    }

    private fun decodeStrictUtf8(data: ByteArray, len: Int): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(data, 0, len))
            .toString()
    } catch (e: CharacterCodingException) {
        null
    }

    /** Outcome of the wrap-time guard table (spec §7). */
    internal sealed interface Decision {
        /** Not capturable at all — no reqId is minted, no entry is produced. */
        object None : Decision

        /** Deliberately not captured; an entry carrying only [reason] is emitted immediately. */
        data class Skip(val reason: BodySkipped) : Decision

        /** Capturable — the tee is attached and an entry arrives at finalization. */
        object Capture : Decision
    }

    /**
     * Guard table (spec §7). Pure: reads headers and the declared length only.
     * The gate check itself is the caller's (the interceptor short-circuits
     * before ever reaching here when the gate is inactive).
     */
    internal fun decide(response: Response, allowlist: List<String>): Decision {
        val body = response.body ?: return Decision.None
        // Explicitly zero — NOT -1, which means "unknown" (chunked, or a
        // transparently gunzipped response whose Content-Length was stripped).
        if (body.contentLength() == 0L) return Decision.None

        // Normally BridgeInterceptor gunzips transparently and strips this
        // header before an application interceptor sees it. If it survived,
        // the host set its own Accept-Encoding and we would tee compressed
        // bytes. Checked before content-type: the encoding is the actionable
        // problem when both apply.
        val encoding = response.header("Content-Encoding")
        if (encoding != null && !encoding.equals("identity", ignoreCase = true)) {
            return Decision.Skip(BodySkipped.Unsupported)
        }

        if (!contentTypeAllowed(response.header("Content-Type"), allowlist)) {
            return Decision.Skip(BodySkipped.ContentType)
        }
        return Decision.Capture
    }

    /**
     * Wrap [response] so its body is teed as the app reads it. Called ONLY for
     * [Decision.Capture]. The returned response is byte-for-byte equivalent
     * from the app's perspective: contentType/contentLength delegate, and the
     * tee never pulls a byte the app did not ask for.
     *
     * This is the whole reason the previous Android body capture was deleted
     * and rebuilt: `Response.peekBody` READ the body a second time, on the
     * app's own call thread, before handing it back. A byte ceiling bounds how
     * much memory such a read costs but nothing bounds how LONG it takes. The
     * tee has neither property by construction — it delegates first and copies
     * only what the app already pulled, so it can never read ahead, never
     * block, and never add a byte of I/O of its own.
     *
     * @param copyFault TEST-ONLY fault injection, always null in production —
     *   invoked inside the copy region's `try`, so a test can exercise its
     *   `catch (t: Throwable)` branch. That branch decides whether a body
     *   truncated by a CAPTURE failure is reported truncated or (the pre-fix
     *   behaviour) as the complete body, so it needs a test; there is no way
     *   to reach it from outside otherwise. The copy can only throw if the
     *   delegate reports more bytes than it wrote into the sink, and
     *   `ResponseBody.source()` must return an `okio.BufferedSource`, which is
     *   a SEALED interface — a test cannot supply a misbehaving one, and a
     *   plain `Source` wrapped in `.buffer()` has its count normalized by
     *   `RealBufferedSource` before the tee ever sees it. Deliberately a
     *   constructor parameter rather than mutable global state: it is a final
     *   per-instance field that is null on every production path (so the JIT
     *   folds the check away) and cannot leak between tests.
     */
    internal fun attach(
        response: Response,
        ctx: NetworkBodyFinalizer.Ctx,
        copyFault: (() -> Unit)? = null,
    ): Response {
        val body = response.body ?: return response
        val declaredLength = body.contentLength()
        val windowCap = (ctx.cap.toLong() + secretScanOverlap)

        val teed = TeeSource(body.source(), windowCap, declaredLength, copyFault) { raw, complete, failed ->
            NetworkBodyFinalizer.submit(raw, complete, failed, declaredLength, ctx)
        }.buffer()

        return response.newBuilder()
            .body(TeeResponseBody(body.contentType(), declaredLength, teed))
            .build()
    }

    private class TeeResponseBody(
        private val type: MediaType?,
        private val length: Long,
        private val teed: BufferedSource,
    ) : ResponseBody() {
        override fun contentType(): MediaType? = type
        override fun contentLength(): Long = length
        override fun source(): BufferedSource = teed
    }

    /**
     * Copies bytes into [captured] AFTER the delegate has already produced
     * them — one read, on the app's own schedule. Once [windowCap] is reached
     * copying stops for good and this degenerates to pure delegation.
     *
     * [onFinalize] receives `(raw, complete, failed)`. `complete` means the
     * captured bytes are the ENTIRE body — either EOF was reached with the
     * window never filled, or we hold at least as many bytes as the response
     * declared (see [finalizeOnce]). `failed` means the delegate threw. Both
     * are deliberately separate from [hitWindow]: a stream that ends after the
     * window already filled DID reach EOF, but what we hold is a prefix, not
     * the body.
     */
    private class TeeSource(
        delegate: Source,
        private val windowCap: Long,
        /** The response's own `contentLength()`, or -1 when unknown. */
        private val declaredLength: Long,
        /** Test-only; null in production. See [attach]'s `copyFault` param. */
        private val copyFault: (() -> Unit)?,
        private val onFinalize: (ByteArray, Boolean, Boolean) -> Unit,
    ) : ForwardingSource(delegate) {

        private val captured = Buffer()

        /**
         * `captured` is an okio [Buffer], which is not thread-safe, and the
         * two mutators do not always run on the same thread: reads happen on
         * the app's call thread while `close()` may arrive from another (a
         * caller abandoning a response it handed to a different thread). Only
         * the copy and the drain are inside this monitor — never the delegate
         * read, which must never happen under a lock.
         */
        private val captureLock = Any()

        @Volatile private var copying = true
        @Volatile private var hitWindow = false
        private val finalized = AtomicBoolean(false)

        override fun read(sink: Buffer, byteCount: Long): Long {
            // DELEGATE FIRST. Everything below only ever looks at bytes the
            // app has already been given.
            val n = try {
                super.read(sink, byteCount)
            } catch (e: IOException) {
                // Transport died. Finalize with whatever arrived, then let the
                // app's own failure semantics proceed untouched.
                finalizeOnce(complete = false, failed = true)
                throw e
            }

            if (n == -1L) {
                finalizeOnce(complete = !hitWindow, failed = false)
                return -1L
            }

            var windowFilled = false
            synchronized(captureLock) {
                if (copying) {
                    try {
                        copyFault?.invoke()
                        if (!Everframe.captureGate) {
                            // DEFE-03: kill() landed mid-stream. Zeroize, stop.
                            captured.clear()
                            copying = false
                        } else {
                            val remaining = windowCap - captured.size
                            if (remaining > 0L) {
                                // `sink` grew by exactly [n] bytes at its TAIL,
                                // so the region the delegate just produced
                                // starts at the pre-read size — `sink.size - n`
                                // — and is [n] long. `sink` is NOT necessarily
                                // empty on entry (okio's `writeAll` reuses one
                                // growing buffer), which is why the offset is
                                // computed rather than assumed to be zero.
                                sink.copyTo(captured, sink.size - n, minOf(n, remaining))
                            }
                            if (captured.size >= windowCap) {
                                hitWindow = true
                                copying = false
                                windowFilled = true
                            }
                        }
                    } catch (t: Throwable) {
                        // Capture failure must never become app failure. Stop
                        // copying — AND record that what we hold is now a
                        // PREFIX, exactly as if the window had filled. Without
                        // `hitWindow = true` the EOF branch above would later
                        // evaluate `complete = !hitWindow` to TRUE and ship a
                        // body truncated by OUR failure as if it were the whole
                        // thing, with `resBodyBytes` presented as ground truth.
                        // (It is also what keeps that `!hitWindow` expression
                        // live: window-fill finalizes immediately, so this
                        // branch is the only way EOF is ever reached with
                        // `hitWindow` already set.)
                        copying = false
                        hitWindow = true
                    }
                }
            }
            // Outside the monitor: finalization hands bytes off to another
            // component and must not run with our lock held.
            if (windowFilled) finalizeOnce(complete = false, failed = false)
            return n
        }

        override fun close() {
            finalizeOnce(complete = false, failed = false)
            super.close()
        }

        private fun finalizeOnce(complete: Boolean, failed: Boolean) {
            if (!finalized.compareAndSet(false, true)) return
            val raw = synchronized(captureLock) {
                // Stop copying too: any read still in flight (or a later one,
                // if close() raced ahead of the app's own reader) would
                // otherwise keep filling a buffer nobody will ever submit.
                copying = false
                captured.readByteArray()
            }
            // BYTES ARE THE TIEBREAKER. A streaming parser (Moshi/Retrofit, and
            // any hand-rolled reader that knows its own framing) reads exactly
            // `contentLength()` bytes and then closes — it never issues the
            // extra read that returns -1, so neither the EOF branch nor
            // `close()` can observe that the body ended, and the capture was
            // reported truncated even though the text we hold IS the whole
            // body. Holding at least as many bytes as the response DECLARED
            // settles it regardless of which trigger got us here.
            // `contentLength()` is -1 when unknown (chunked / stripped), so
            // this only ever fires on a real declaration.
            val whole = complete || (declaredLength >= 0L && raw.size.toLong() >= declaredLength)
            onFinalize(raw, whole, failed)
        }
    }
}
