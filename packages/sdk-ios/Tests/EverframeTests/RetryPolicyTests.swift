// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
@testable import EverframeKit

final class RetryPolicyTests: XCTestCase {

    func test_classify_2xx_terminal_no_retry() {
        let c = RetryPolicy.classify(statusCode: 200, headers: [:], error: nil)
        if case .terminal = c { /* ok */ } else { XCTFail("expected .terminal for 200, got \(c)") }
    }

    func test_classify_400_terminal() {
        let c = RetryPolicy.classify(statusCode: 400, headers: [:], error: nil)
        if case .terminal = c { /* ok */ } else { XCTFail("expected .terminal for 400, got \(c)") }
    }

    func test_classify_408_retryable() {
        let c = RetryPolicy.classify(statusCode: 408, headers: [:], error: nil)
        if case .retryable = c { /* ok */ } else { XCTFail("expected .retryable for 408, got \(c)") }
    }

    func test_classify_429_retryAfter_parses_seconds() {
        let c = RetryPolicy.classify(statusCode: 429, headers: ["Retry-After": "30"], error: nil)
        guard case .retryAfter(let secs) = c else {
            XCTFail("expected .retryAfter for 429, got \(c)")
            return
        }
        XCTAssertEqual(secs, 30, accuracy: 0.001)
    }

    func test_classify_429_default_60s_when_no_header() {
        let c = RetryPolicy.classify(statusCode: 429, headers: [:], error: nil)
        guard case .retryAfter(let secs) = c else {
            XCTFail("expected .retryAfter for 429, got \(c)")
            return
        }
        XCTAssertEqual(secs, 60, accuracy: 0.001)
    }

    func test_classify_500_retryable() {
        let c = RetryPolicy.classify(statusCode: 500, headers: [:], error: nil)
        if case .retryable = c { /* ok */ } else { XCTFail("expected .retryable for 500, got \(c)") }
    }

    func test_classify_503_retryable() {
        let c = RetryPolicy.classify(statusCode: 503, headers: [:], error: nil)
        if case .retryable = c { /* ok */ } else { XCTFail("expected .retryable for 503, got \(c)") }
    }

    func test_classify_URLError_timedOut_retryable() {
        let err = URLError(.timedOut)
        let c = RetryPolicy.classify(statusCode: nil, headers: [:], error: err)
        if case .retryable = c { /* ok */ } else { XCTFail("expected .retryable for .timedOut, got \(c)") }
    }

    func test_classify_URLError_notConnected_retryable() {
        let err = URLError(.notConnectedToInternet)
        let c = RetryPolicy.classify(statusCode: nil, headers: [:], error: err)
        if case .retryable = c { /* ok */ } else { XCTFail("expected .retryable, got \(c)") }
    }

    func test_classify_URLError_cancelled_terminal() {
        let err = URLError(.cancelled)
        let c = RetryPolicy.classify(statusCode: nil, headers: [:], error: err)
        if case .terminal = c { /* ok */ } else { XCTFail("expected .terminal for .cancelled, got \(c)") }
    }

    func test_delay_attempt1_zero() throws {
        XCTAssertEqual(try RetryPolicy.delay(forAttempt: 1), 0, accuracy: 0.001)
    }

    func test_delay_attempt5_7200s() throws {
        XCTAssertEqual(try RetryPolicy.delay(forAttempt: 5), 7200, accuracy: 0.001)
    }

    func test_delay_attempt6_throws() {
        XCTAssertThrowsError(try RetryPolicy.delay(forAttempt: 6))
    }

    func test_delay_attempt0_throws() {
        XCTAssertThrowsError(try RetryPolicy.delay(forAttempt: 0))
    }

    func test_delay_schedule_locked() throws {
        XCTAssertEqual(try RetryPolicy.delay(forAttempt: 1), 0)
        XCTAssertEqual(try RetryPolicy.delay(forAttempt: 2), 60)
        XCTAssertEqual(try RetryPolicy.delay(forAttempt: 3), 300)
        XCTAssertEqual(try RetryPolicy.delay(forAttempt: 4), 1800)
        XCTAssertEqual(try RetryPolicy.delay(forAttempt: 5), 7200)
    }
}
