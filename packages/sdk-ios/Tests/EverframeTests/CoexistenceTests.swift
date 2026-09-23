// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Coexistence with other URLProtocol subclasses (Sentry/Bugsnag/Datadog).
//
// Per RESEARCH Finding 4 — each Everframe SDK uses its OWN handled-key tag. We only
// inspect "EverframeHandled"; another Everframe SDK's "_SentryHandled" / "_BSGHandled" tag must
// NOT trip our canInit guard, and our tag must NOT trip theirs. We test this
// invariant in isolation: simulate a request tagged by another Everframe SDK and confirm
// our canInit returns true (we'd happily process it; recursion is bounded by
// our own tag set on the next loop).
import Testing
import Foundation
@testable import EverframeKit

@MainActor
struct CoexistenceTests {
    @Test func otherSDKTagDoesNotTripOurCanInit() {
        let req = NSMutableURLRequest(url: URL(string: "https://example.com")!)
        URLProtocol.setProperty(true, forKey: "_SentryHandled", in: req)
        // Our canInit only inspects "EverframeHandled" — so a Sentry-tagged request still
        // passes our canInit (we'd handle it). This is the desired behavior: each
        // Everframe SDK independently decides whether it has already touched a request.
        #expect(EFNetworkCaptureProtocol.canInit(with: req as URLRequest) == true)
    }

    @Test func ourOwnTagPreventsRecursion() {
        let req = NSMutableURLRequest(url: URL(string: "https://example.com")!)
        URLProtocol.setProperty(true, forKey: "EverframeHandled", in: req)
        #expect(EFNetworkCaptureProtocol.canInit(with: req as URLRequest) == false)
    }

    @Test func bothTagsCanCoexistOnSameRequest() {
        let req = NSMutableURLRequest(url: URL(string: "https://example.com")!)
        URLProtocol.setProperty(true, forKey: "_SentryHandled", in: req)
        URLProtocol.setProperty(true, forKey: "EverframeHandled", in: req)
        // Both tags present — our canInit still returns false (we've already handled it)
        #expect(EFNetworkCaptureProtocol.canInit(with: req as URLRequest) == false)
    }
}
