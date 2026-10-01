// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import CryptoKit
import Testing
import UIKit
@testable import EverframeKit
@testable import EverframeProtocol

@MainActor
struct FlutterReplayAttachmentTests {
    private func png(_ color: UIColor) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 4, height: 2), format: format)
            .pngData { context in
                color.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 4, height: 2))
            }
    }

    private func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func timeline(text: String? = nil) throws -> Data {
        let first = png(.green)
        let second = png(.blue)
        let a = String(hash(first).prefix(16))
        let b = String(hash(second).prefix(16))
        var node: [String: Any] = [
            "id": "flutter-root", "role": "image", "imageRef": a, "children": [],
            "frame": ["x": 0, "y": 0, "w": 4, "h": 2],
        ]
        if let text { node["text"] = text }
        let object: [String: Any] = [
            "version": "everframe-vtree-v1",
            "originEpochMs": 12345,
            "viewport": ["width": 4, "height": 2, "scale": 1],
            "frames": [
                ["timestamp": 0, "ops": [["op": "add", "parent": "", "index": 0, "node": node]]],
                ["timestamp": 200, "ops": [["op": "set", "id": "flutter-root", "imageRef": b]]],
            ],
            "assets": [
                a: ["mime": "image/png", "w": 4, "h": 2, "b64": first.base64EncodedString()],
                b: ["mime": "image/png", "w": 4, "h": 2, "b64": second.base64EncodedString()],
            ],
        ]
        return try JSONSerialization.data(withJSONObject: object)
    }

    @Test func attachesOnlyImageTimeline() throws {
        let data = try timeline()
        let pair = ReporterSubmission.buildFlutterReplayAttachment(data, byteBudget: 8 * 1024 * 1024)
        #expect(pair != nil)
        #expect(pair?.envelope.format == .everframeVtreeV1)
        #expect(pair?.envelope.contentType == "application/octet-stream")
        #expect(pair?.envelope.replayStartEpochMS == 12345)
        #expect(pair?.multipart.data == data)
        #expect(pair?.envelope.sha256 == hash(data))
    }

    @Test func rejectsTextAndInvalidBudget() throws {
        #expect(ReporterSubmission.buildFlutterReplayAttachment(
            try timeline(text: "private"), byteBudget: 8 * 1024 * 1024) == nil)
        #expect(ReporterSubmission.buildFlutterReplayAttachment(
            try timeline(), byteBudget: 1) == nil)
    }
}
#endif
