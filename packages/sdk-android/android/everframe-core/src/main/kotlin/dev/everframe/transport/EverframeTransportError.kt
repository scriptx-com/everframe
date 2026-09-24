// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Transport-layer error sealed class. Plan 05-02 declared a placeholder under
// `config/`; Plan 05-05 relocated the canonical home here per its files_modified
// path and extended:
//   • ServerError now carries (statusCode, responseBody) — the bounded 512-char
//     server-response preview captured by MultipartUploader feeds back into the
//     thrown exception so host-app error handlers see WHY the server rejected.
//   • RetryPolicyError covers attempt-out-of-range from RetryPolicy.delay(forAttempt:)
//     — distinct from a genuine transport failure so the retry loop can dead-letter.
//   • OutboxFull retained for forward-compat (no callers yet; reserved for the
//     PIPE-03 25MB cap path when an envelope is rejected pre-enqueue).
//
// Mirrors `packages/sdk-ios/Sources/Everframe/Transport/EverframeTransportError.swift`
// with Android idioms: data class for cases that carry payload, object for singletons.
package dev.everframe.transport

sealed class EverframeTransportError(message: String) : Exception(message) {

    /** Terminal HTTP status — the body preview (≤512 chars, post-redaction at server). */
    data class ServerError(val statusCode: Int, val responseBody: String?) :
        EverframeTransportError("server error status=$statusCode")

    /** OkHttp surfaced an unrecoverable IOException (UnknownHost on terminal classify). */
    object NetworkUnavailable :
        EverframeTransportError("network unavailable")

    /** Reserved for PIPE-03 25 MB envelope-cap rejection at submitter pre-enqueue. */
    data class PayloadTooLarge(val byteCount: Long) :
        EverframeTransportError("payload $byteCount bytes exceeds PIPE-03 cap")

    /** RetryPolicy.delay(forAttempt) called outside [1, MAX_ATTEMPTS]. */
    class RetryPolicyError(message: String) : EverframeTransportError(message)
}
