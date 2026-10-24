// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

@MainActor
public enum ScreenshotCapture {

    public struct Result {
        public let image: UIImage
        public let widthPoints: CGFloat
        public let heightPoints: CGFloat
        public let scale: CGFloat
        public let pngData: Data

        public init(image: UIImage, widthPoints: CGFloat, heightPoints: CGFloat,
                    scale: CGFloat, pngData: Data) {
            self.image = image
            self.widthPoints = widthPoints
            self.heightPoints = heightPoints
            self.scale = scale
            self.pngData = pngData
        }
    }

    /// Max output dimension (longer edge). RESEARCH Finding 2 — caps multipart payload size.
    public static let MAX_EDGE_PT: CGFloat = 2048.0

    /// Capture the host's active foreground key window. Returns nil if no foreground scene found
    /// (background app, no UI scene yet, etc.). Per RESEARCH Finding 7 — uses
    /// `UIWindowScene.activationState == .foregroundActive` and `isKeyWindow`; the legacy
    /// shared-screen API is intentionally avoided (Pitfall 6 — Stage Manager safety).
    public static func captureKeyWindow() -> Result? {
        guard let window = activeKeyWindow() else { return nil }
        let sensitiveRects = SensitiveRectRegistry.collectSensitiveRects(in: window)
        return capture(window: window, blackoutRects: sensitiveRects)
    }

    /// Renders `drawContent` into a (possibly downscaled) bitmap and bakes
    /// `blackoutRects` black over it, BEFORE any encode. The one place the
    /// PRIV-03 ordering lives, so there are not two copies of it to drift
    /// apart.
    ///
    /// `drawContent` is injected rather than hardcoded to
    /// `window.drawHierarchy` because that call renders NOTHING — a uniformly
    /// black bitmap — unless the window belongs to a foreground-active scene,
    /// and a SwiftPM test bundle has no scenes at all
    /// (`UIApplication.shared.connectedScenes` is empty). Without this seam the
    /// only available masking test is one that samples a black pixel inside the
    /// rect on a frame where every pixel is black, i.e. an assertion that
    /// cannot fail. That is not hypothetical: it is exactly the state the
    /// Android twin's privacy test was in until 2026-08-12.
    ///
    /// - Parameter drawContent: receives the ORIGINAL (un-downscaled) bounds;
    ///   the context is already scaled, so draw in original coordinates.
    static func renderMasked(bounds: CGRect,
                             scale: CGFloat,
                             maxEdge: CGFloat,
                             blackoutRects: [CGRect],
                             drawContent: (CGRect) -> Void) -> UIImage? {
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let longerEdge = max(bounds.width, bounds.height)
        let downscale = longerEdge > maxEdge ? maxEdge / longerEdge : 1.0
        let outputSize = CGSize(width: bounds.width * downscale, height: bounds.height * downscale)

        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = scale
        format.opaque = true
        // Force sRGB on tvOS — preferred() may pick extended-range / Display P3
        // which gets clipped/darkened during PNG encode (PNG is sRGB by default).
        // On iOS/iPadOS the preferred format renders correctly, so we leave it alone.
        #if os(tvOS)
        format.preferredRange = .standard
        #endif

        return UIGraphicsImageRenderer(size: outputSize, format: format).image { ctx in
            if downscale != 1.0 {
                let cg = ctx.cgContext
                cg.scaleBy(x: downscale, y: downscale)
                drawContent(bounds)
                // Restore identity for blackout fills (we want them in output-pixel space).
                cg.scaleBy(x: 1.0 / downscale, y: 1.0 / downscale)
            } else {
                drawContent(bounds)
            }
            // PRIV-03 — bake blackout BEFORE encode.
            ctx.cgContext.setFillColor(UIColor.black.cgColor)
            for rect in blackoutRects {
                let scaled = downscale != 1.0
                    ? CGRect(x: rect.origin.x * downscale, y: rect.origin.y * downscale,
                             width: rect.width * downscale, height: rect.height * downscale)
                    : rect
                ctx.cgContext.fill(scaled)
            }
        }
    }

    /// Public for testing; production path uses `captureKeyWindow()`.
    public static func capture(window: UIWindow, blackoutRects: [CGRect]) -> Result? {
        // Render the LIVE window's hierarchy directly into the bitmap context.
        // Earlier revisions used `snapshotView(afterScreenUpdates: true)` and
        // then `drawHierarchy(in:afterScreenUpdates: false)` on that detached
        // snapshot, which produced black pixels — UIKit logs the same as
        // "Rendering a view (_UIReplicantView) that has not been rendered at
        // least once requires afterScreenUpdates:YES." `snapshotView` returns
        // a `_UIReplicantView` intended for transition animations, not bitmap
        // capture. Drawing the window's hierarchy with `afterScreenUpdates:
        // true` is the canonical path and works correctly when the window is
        // attached and key.
        // Note for tvOS hosts: tvOS UIWindows are typically transparent — the
        // visible background on screen is the system wallpaper, which apps
        // CANNOT capture (privacy). If the host's view tree is also transparent
        // in places, those areas render as opaque black in the captured bitmap.
        // The fix lives in the host app: give the root view a solid background
        // (`.background(Color.black.ignoresSafeArea())` or similar). The Everframe SDK
        // does not guess at a wallpaper colour — that would mislead the user.
        guard let image = renderMasked(bounds: window.bounds,
                                       scale: window.screen.scale,
                                       maxEdge: MAX_EDGE_PT,
                                       blackoutRects: blackoutRects,
                                       drawContent: { bounds in
                                           window.drawHierarchy(in: bounds, afterScreenUpdates: true)
                                       })
        else { return nil }
        let outputSize = image.size

        guard let png = image.pngData() else { return nil }
        return Result(image: image,
                      widthPoints: outputSize.width,
                      heightPoints: outputSize.height,
                      scale: window.screen.scale,
                      pngData: png)
    }

    /// Per RESEARCH Finding 7 — find the foreground active host window across multi-scene iPad.
    /// Avoids the legacy shared-screen API (Pitfall 6 — Stage Manager / external display safety).
    ///
    /// We deliberately pick the *lowest-level visible* window rather than the
    /// `isKeyWindow` window. Hosts that install a floating-bubble overlay
    /// (sample app pattern post-Phase 05.1) put it at `windowLevel = .normal + 1`;
    /// when the user taps the bubble button, UIKit promotes the bubble window
    /// to key, and capturing that window would render mostly empty (just the
    /// bubble itself over a transparent backdrop). The host's main UI lives at
    /// `windowLevel == .normal` (default) — picking the lowest level reliably
    /// finds it, and naturally skips bubble overlays AND our own reporter
    /// window (which sits at `.alert + 1`).
    /// Test-only override — a SwiftPM test bundle has NO UI scenes at all
    /// (`UIApplication.shared.connectedScenes` is empty), so
    /// `activeKeyWindow()`'s real window source can't be driven from a
    /// host-runnable test. When set, `activeKeyWindow()` filters/sorts THIS
    /// list instead of querying `UIApplication.shared` — lets finding N4's
    /// overlay-window exclusion be asserted deterministically with plain
    /// `UIWindow(frame:)` fixtures (no scene needed for that constructor).
    /// `nil` (the default) is production behavior, untouched.
    nonisolated(unsafe) static var __windowsOverrideForTesting: [UIWindow]?

    public static func activeKeyWindow() -> UIWindow? {
        let candidates: [UIWindow]
        if let override = __windowsOverrideForTesting {
            candidates = override.filter { !$0.isHidden }
        } else {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first(where: { $0.activationState == .foregroundActive })
            guard let sceneWindows = scene?.windows.filter({ !$0.isHidden }) else { return nil }
            candidates = sceneWindows
        }
        // External review, finding N4 — filter out the Everframe SDK's own
        // overlay windows BEFORE the level sort runs. The level-ordering
        // heuristic below picks the LOWEST-level visible window as a proxy
        // for "the host's main window", which breaks the moment the host's
        // real window is only TRANSIENTLY hidden (a scene transition, a host
        // animating its window out and back): with the host window
        // momentarily `isHidden`, an SDK overlay becomes the lowest
        // surviving candidate and every capture path routing through this
        // method (screenshot, VTree, UITree) resolves to an Everframe SDK
        // overlay instead of the host's UI. Capture must never resolve to an
        // Everframe SDK overlay window even when it is momentarily the only visible
        // one — the level rule below remains the tie-breaker for ordinary
        // host layering, it just never gets to see this window at all.
        // The quick-capture toast and the device-link banner are the
        // overlays excluded here.
        let nonOverlayCandidates = candidates.filter {
            !($0 is EFQuickCaptureToastWindow) && !($0 is EFDeviceLinkBannerWindow)
        }
        // Lowest windowLevel = host's main window. Tie-breaker: prefer the
        // current isKeyWindow if multiple windows share that level.
        return nonOverlayCandidates
            .sorted { lhs, rhs in
                if lhs.windowLevel != rhs.windowLevel {
                    return lhs.windowLevel < rhs.windowLevel
                }
                return lhs.isKeyWindow && !rhs.isKeyWindow
            }
            .first
    }
}
#endif
