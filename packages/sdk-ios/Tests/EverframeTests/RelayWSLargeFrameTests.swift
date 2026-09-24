// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import Network
import EverframeProtocol
@testable import EverframeKit

/// Real loopback WebSocket transport: a legal TV screenshot must reach the
/// submit bridge, not disconnect at Foundation's default receive limit.
@MainActor final class RelayWSLargeFrameTests: XCTestCase {
    func testMultiMegabyteScreenshotReachesSubmitBridge() async throws {
        let queue = DispatchQueue(label: "everframe.test.websocket")
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        let ready = expectation(description: "loopback listener ready")
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        let payload = Data(repeating: 0x5a, count: 2 * 1024 * 1024)
        let submit = try JSONEncoder().encode(EverframeReportSubmit(annotations: [], correlationId: "large-tv-shot",
            description: .init(redactions: [], text: "large screenshot"),
            includes: .init(logs: false, metadata: true, network: false, screenshot: true, uiTree: false),
            title: "TV", type: "report.submit"))
        let peers = LoopbackPeers()
        defer { peers.cancelAll() }
        listener.newConnectionHandler = { connection in
            peers.keep(connection)
            connection.stateUpdateHandler = { [weak connection] state in
                if case .ready = state, let connection {
                    let metadata = NWProtocolWebSocket.Metadata(opcode: .binary)
                    let context = NWConnection.ContentContext(identifier: "screenshot", metadata: [metadata])
                    let header = NWConnection.ContentContext(identifier: "submit", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
                    connection.send(content: submit, contentContext: header, isComplete: true,
                        completion: .contentProcessed { error in
                            guard error == nil else { return }
                            connection.send(content: payload, contentContext: context, isComplete: true,
                                completion: .contentProcessed { _ in })
                        })
                }
            }
            connection.start(queue: queue)
        }
        listener.start(queue: queue)
        defer { listener.cancel() }
        await fulfillment(of: [ready], timeout: 5)
        let port = try XCTUnwrap(listener.port)
        let companion = CompanionAPI()
        let client = RelayWSClient(endpoint: URL(string: "http://127.0.0.1:\(port.rawValue)")!, companion: companion)
        defer { client.disconnect() }
        let received = expectation(description: "complete two MiB screenshot delivered")
        let token = NotificationCenter.default.addObserver(forName: .everframeCompanionReportSubmitBinary,
            object: client, queue: nil) { notification in
                guard notification.userInfo?["correlation_id"] as? String == "large-tv-shot" else { return }
                XCTAssertEqual(notification.userInfo?["bytes"] as? Data, payload)
                received.fulfill()
            }
        defer { NotificationCenter.default.removeObserver(token) }
        client.connect()
        await fulfillment(of: [received], timeout: 5)
    }
}

private final class LoopbackPeers: @unchecked Sendable {
    private let lock = NSLock()
    private var connections: [NWConnection] = []
    private var stopped = false
    func keep(_ connection: NWConnection) {
        lock.lock(); defer { lock.unlock() }
        if stopped { connection.cancel() } else { connections.append(connection) }
    }
    func cancelAll() {
        lock.lock()
        stopped = true
        let old = connections; connections.removeAll()
        lock.unlock()
        old.forEach { $0.cancel() }
    }
}
