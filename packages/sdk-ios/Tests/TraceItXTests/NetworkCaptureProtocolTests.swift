// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TXNetworkCaptureProtocol behavior — recursion-tag, opt-in config helper, no-body schema.
import Testing
import Foundation
@testable import TraceItXKit

@MainActor
struct NetworkCaptureProtocolTests {
    @Test func canInit_returnsFalseForTaggedRequest() {
        let req = NSMutableURLRequest(url: URL(string: "https://example.com")!)
        URLProtocol.setProperty(true, forKey: "TXHandled", in: req)
        #expect(TXNetworkCaptureProtocol.canInit(with: req as URLRequest) == false)
    }

    @Test func canInit_returnsTrueForUntaggedRequest() {
        let req = URLRequest(url: URL(string: "https://example.com")!)
        #expect(TXNetworkCaptureProtocol.canInit(with: req) == true)
    }

    @Test func networkCaptureConfiguration_insertsProtocolAtIndex0() {
        let cfg = TraceItX.shared.networkCaptureConfiguration()
        #expect(cfg.protocolClasses?.first == TXNetworkCaptureProtocol.self)
    }

    @Test func networkCaptureConfiguration_neverMutatesURLSessionShared() {
        let beforeShared = URLSession.shared.configuration.protocolClasses?.count ?? 0
        _ = TraceItX.shared.networkCaptureConfiguration()
        let afterShared = URLSession.shared.configuration.protocolClasses?.count ?? 0
        #expect(beforeShared == afterShared)
    }

    @Test func recordsEntryWithoutBody() throws {
        try? TraceItX.shared.start(config: .init(appId: "txx_live_BToSbdPgUWSxvuE8eTBg948e8q04j1rU"))
        NetworkRingBuffer.shared.clear()
        let entry = NetworkLogEntry(
            timestamp: Date(),
            method: "GET",
            url: "https://example.com",
            status: 200,
            durationMs: 10.0,
            requestHeaders: ["x-trace-id": "abc"],
            responseHeaders: ["content-type": "application/json"]
        )
        NetworkRingBuffer.shared.append(entry)
        let snap = NetworkRingBuffer.shared.snapshot()
        #expect(snap.count >= 1)
        // Codable round-trip — verify schema has no body field
        let json = try JSONEncoder().encode(snap)
        let s = String(data: json, encoding: .utf8) ?? ""
        #expect(!s.contains("\"body\""))
        #expect(!s.contains("requestBody"))
        #expect(!s.contains("responseBody"))
    }
}
