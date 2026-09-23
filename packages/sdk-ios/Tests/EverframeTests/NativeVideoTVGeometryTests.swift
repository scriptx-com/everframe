// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit
import AVFoundation
import Testing
@testable import EverframeKit

@MainActor @Suite(.serialized) struct NativeVideoTVGeometryTests {
    @Test(arguments: [CGSize(width: 1920, height: 1080), CGSize(width: 3840, height: 2160)])
    func landscapeWindowsStayBoundedAndMaskSensitiveContent(size: CGSize) async throws {
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let secret = EFSensitiveView(frame: CGRect(x: size.width / 2, y: 0, width: size.width / 2, height: size.height))
        secret.backgroundColor = .magenta; window.addSubview(secret)
        let capture = NativeVideoCapture()
        let frame = try #require(await capture.capture(window: window, timestampNanos: 123))
        #expect(frame.width == 854); #expect(frame.height == 480)
        #expect(frame.bgraBytes.count == 1_639_680)
        #expect(pixel(frame, 100, 240) == [255, 255, 255, 255])
        #expect(pixel(frame, 700, 240) == [0, 0, 0, 255])
    }

    // Must run on tvOS too: AVPlayer exclusion must not live inside a WebKit guard.
    @Test func playerSurfaceAndFocusedSensitiveOverflowAreOpaque() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 192, height: 108))
        window.backgroundColor = .white; window.isHidden = false
        defer { window.isHidden = true }
        let player = AVPlayerLayer(); player.frame = CGRect(x: 0, y: 0, width: 80, height: 108)
        player.backgroundColor = UIColor.red.cgColor; window.layer.addSublayer(player)
        let card = EFSensitiveView(frame: CGRect(x: 120, y: 30, width: 40, height: 40))
        card.backgroundColor = .red; card.transform = CGAffineTransform(scaleX: 1.5, y: 1.5)
        window.addSubview(card)
        let frame = try #require(await NativeVideoCapture().capture(window: window, timestampNanos: 123))
        #expect(pixel(frame, 40, 50) == [0, 0, 0, 255])
        #expect(pixel(frame, 112, 22) == [0, 0, 0, 255])
        #expect(pixel(frame, 180, 90) == [255, 255, 255, 255])
    }

    private func pixel(_ frame: NativeVideoFrame, _ x: Int, _ y: Int) -> [UInt8] {
        let offset = y * frame.bytesPerRow + x * 4
        return Array(frame.bgraBytes[offset..<offset + 4])
    }
}
#endif
