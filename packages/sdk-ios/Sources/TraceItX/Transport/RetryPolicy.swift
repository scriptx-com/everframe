// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Classification of an HTTP/transport outcome for retry purposes.
public enum RetryClassification: Equatable {
    case retryable
    case terminal
    case retryAfter(seconds: TimeInterval)
}

/// Error thrown by `RetryPolicy.delay(forAttempt:)` when the attempt index is
/// outside the locked schedule (1...5). This is intentionally distinct from
/// `TraceItXTransportError` so the retry loop can differentiate "we hit max
/// attempts and must dead-letter" from a genuine transport failure.
public struct RetryPolicyError: Error, Equatable {
    public let attempt: Int
    public init(attempt: Int) { self.attempt = attempt }
}

/// LOCKED retry schedule (PIPE-02): 5 attempts at 0s, 1m, 5m, 30m, 2h.
/// Server-side schedule is longer (Phase 02.1, 10 attempts over ~3 days);
/// client-side caps at 2h because the user is waiting on submission feedback.
public struct RetryPolicy {

    public static let MAX_ATTEMPTS = 5

    /// Wait-before-this-attempt schedule. `DELAY_SECONDS[i]` is the delay
    /// observed before attempt `i+1`. attempt 1 = 0s (immediate first try).
    public static let DELAY_SECONDS: [TimeInterval] = [0, 60, 300, 1800, 7200]

    /// Classify an HTTP response or transport error.
    public static func classify(statusCode: Int?, headers: [AnyHashable: Any], error: Error?) -> RetryClassification {
        if let urlErr = error as? URLError {
            switch urlErr.code {
            case .notConnectedToInternet,
                 .timedOut,
                 .networkConnectionLost,
                 .dnsLookupFailed,
                 .cannotConnectToHost:
                return .retryable
            default:
                return .terminal
            }
        }
        guard let s = statusCode else { return .terminal }

        if s == 408 { return .retryable }
        if s == 429 {
            let secs = parseRetryAfter(headers) ?? 60
            return .retryAfter(seconds: secs)
        }
        if (500...599).contains(s) { return .retryable }
        // 2xx success and 4xx (except 408/429) are both terminal — neither retries.
        return .terminal
    }

    /// Delay (in seconds) the caller should wait before performing `attempt`.
    /// `attempt` is 1-based; throws if outside [1, MAX_ATTEMPTS].
    public static func delay(forAttempt attempt: Int) throws -> TimeInterval {
        guard attempt >= 1 && attempt <= MAX_ATTEMPTS else {
            throw RetryPolicyError(attempt: attempt)
        }
        return DELAY_SECONDS[attempt - 1]
    }

    // MARK: - Private

    /// Parse the `Retry-After` header (RFC 7231 §7.1.3). Supports the
    /// "delta-seconds" form (e.g. "30"); the HTTP-date form falls back to nil
    /// (caller substitutes a default).
    private static func parseRetryAfter(_ headers: [AnyHashable: Any]) -> TimeInterval? {
        // HTTP headers are case-insensitive; check common spellings.
        let candidates: [Any?] = [
            headers["Retry-After"],
            headers["retry-after"],
            headers["RETRY-AFTER"],
        ]
        for raw in candidates {
            guard let str = raw as? String else { continue }
            let trimmed = str.trimmingCharacters(in: .whitespaces)
            if let n = Double(trimmed) { return n }
        }
        return nil
    }
}
