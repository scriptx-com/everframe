// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Regression coverage for first-layout transform precision: on the initial
// viewDidLayoutSubviews() pass, the editor image must render at fitted scale
// (not at natural size "zoomed"), even before any user interaction.
//
// Bug (device QA): `overlay` is a nested subview whose bounds are .zero on
// the root view's first layout pass. `ImageTransform` built from .zero bounds
// returns identity (scale 1, offset 0), so `imageView.frame = transform.imageFrameInView`
// becomes the image's full natural size instead of fitted. A later pass
// (triggered by first tap invalidating layout) finally builds the correct
// transform.
//
// Fix: call `canvasContainer.layoutIfNeeded()` in `viewDidLayoutSubviews` to
// resolve nested layout before reading bounds, and skip transform rebuild
// while bounds are degenerate.

import Testing
import Foundation
#if canImport(UIKit) && !os(tvOS)
import UIKit
@testable import EverframeReporterUI

@Suite(.serialized)
@MainActor
struct EditorFirstLayoutTests {

    /// Large source image (1200×2000) — larger than the test window (390×844)
    /// so the transform must scale it DOWN to fit.
    private func makeLargeSourceImage() -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1.0
        format.opaque = true
        let r = UIGraphicsImageRenderer(size: CGSize(width: 1200, height: 2000), format: format)
        return r.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 1200, height: 2000))
        }
    }

    @Test func firstLayoutFitsImageWithoutInteraction() throws {
        let vc = FocusedAnnotationViewController(sourceImage: makeLargeSourceImage())

        // iPhone-width window (390×844, matching typical device safe area layout)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = vc
        window.makeKeyAndVisible()
        vc.loadViewIfNeeded()
        vc.view.layoutIfNeeded()

        _ = window // keep alive for VC's lifetime

        // Assertion 1: scale must be < 1 (image scaled DOWN to fit window)
        // If the bug is present, scale == 1 because overlay.bounds == .zero
        // on the first pass → transform returns identity.
        #expect(vc.transform.scale < 1, "Image must scale DOWN to fit window on first layout")

        // Assertion 2: imageView's actual frame width must not exceed window
        // (the 390pt overlay width). If the bug is present, imageView.width
        // equals the image's natural 1200pt (natural size, "zoomed").
        #expect(
            vc.imageView.frame.width <= 390,
            "ImageView width \(vc.imageView.frame.width) must fit within window (390pt) on first layout"
        )

        // Assertion 3: height must also fit proportionally.
        #expect(
            vc.imageView.frame.height <= 844,
            "ImageView height \(vc.imageView.frame.height) must fit within window (844pt) on first layout"
        )
    }
}
#endif
