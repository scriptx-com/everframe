// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared fixtures for the stage-4c image-capture suites. Kept in one place
// because the capture tests, the bundled-gate tests, the producer-wiring tests
// and the end-to-end test all need the same three things: images whose pixels
// are known, a real hosted window (the frame guard takes the convert() path
// only for a view actually in a window), and a way to read the SHIPPED bytes
// back to pixels.
#if canImport(UIKit)
import UIKit
import XCTest
import TraceItXProtocol

@MainActor
enum ImageHarness {

    // MARK: - Images with known pixels

    /// An opaque square of one colour.
    static func solid(_ color: UIColor, _ size: CGFloat) -> UIImage {
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        fmt.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: fmt).image { c in
            color.setFill()
            c.fill(CGRect(x: 0, y: 0, width: size, height: size))
        }
    }

    /// An opaque `w`×`h` image split vertically down the middle.
    static func split(leftHalf: UIColor, rightHalf: UIColor, w: CGFloat, h: CGFloat) -> UIImage {
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        fmt.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: fmt).image { c in
            leftHalf.setFill()
            c.fill(CGRect(x: 0, y: 0, width: w / 2, height: h))
            rightHalf.setFill()
            c.fill(CGRect(x: w / 2, y: 0, width: w / 2, height: h))
        }
    }

    /// A LAZILY-DECODED image, the shape a real camera photo or download has.
    /// Deliberately not a `UIGraphicsImageRenderer` product: the bundled gate
    /// must refuse this, and the whole point is that it arrives as bytes.
    static func photo(_ color: UIColor = .red, _ size: CGFloat = 64) -> UIImage {
        let data = solid(color, size).jpegData(compressionQuality: 0.9)!
        return UIImage(data: data)!
    }

    /// An SF Symbol — the one image kind iOS can positively identify as the
    /// app's own shipped asset (see the plan's Measurements section).
    static func symbol(_ name: String = "star.fill") -> UIImage {
        // Force-unwrapped on purpose: a missing system symbol means the test
        // host is broken, and a silent nil would make every bundled assertion
        // vacuous.
        UIImage(systemName: name)!
    }

    // MARK: - A real hosted window

    /// A key-and-visible window with a root view controller, plus one image view
    /// added to it. Hold the returned window for the test's lifetime.
    static func hosted(
        frame: CGRect = CGRect(x: 20, y: 40, width: 100, height: 100),
        _ configure: (UIImageView) -> Void
    ) -> (window: UIWindow, view: UIImageView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let vc = UIViewController()
        window.rootViewController = vc
        window.makeKeyAndVisible()
        let iv = UIImageView(frame: frame)
        configure(iv)
        vc.view.addSubview(iv)
        window.layoutIfNeeded()
        return (window, iv)
    }

    // MARK: - Reading the shipped bytes back

    struct Pixels {
        let w: Int
        let h: Int
        private let bytes: [UInt8]

        init(w: Int, h: Int, bytes: [UInt8]) {
            self.w = w
            self.h = h
            self.bytes = bytes
        }

        /// NON-premultiplied RGBA at (x, y), so a colour assertion is
        /// independent of the alpha assertion.
        func at(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
            let i = (y * w + x) * 4
            let a = Int(bytes[i + 3])
            func un(_ v: UInt8) -> Int { a == 0 ? 0 : min(255, Int(v) * 255 / a) }
            return (un(bytes[i]), un(bytes[i + 1]), un(bytes[i + 2]), a)
        }
    }

    /// Decode a `VAsset`'s base64 through ImageIO back to pixels. Assertions run
    /// against THIS, not an intermediate, so a test cannot pass while the encode
    /// step is wrong.
    static func pixels(of asset: VAsset) throws -> Pixels {
        let data = try XCTUnwrap(Data(base64Encoded: asset.b64), "asset b64 did not decode")
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil),
                                   "asset bytes are not a decodable image")
        let cg = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let w = cg.width, h = cg.height
        XCTAssertEqual(Int(asset.w), w, "VAsset.w disagrees with the encoded bytes")
        XCTAssertEqual(Int(asset.h), h, "VAsset.h disagrees with the encoded bytes")
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        buf.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(
                data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
                bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return Pixels(w: w, h: h, bytes: buf)
    }

    /// Every `imageRef` in a VNode tree.
    static func refs(in node: VNode) -> Set<String> {
        var out = Set<String>()
        func walk(_ n: VNode) {
            if let r = n.imageRef { out.insert(r) }
            for c in n.children { walk(c) }
        }
        walk(node)
        return out
    }
}
#endif
