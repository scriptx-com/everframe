// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import UIKit

/// Bytes plus the shape and encoding that actually produced them.
///
/// `mime` travels WITH the bytes so nothing downstream has to guess or
/// hardcode an encoding. The Android twin originally announced
/// `"image/webp"` over JPEG bytes and shipped them as report evidence.
///
/// Top-level rather than nested in `ScreenshotCapture`: it is the shape that
/// crosses from the capture layer into the companion layer, and both sides
/// name it constantly.
public struct PreviewCapture: Sendable {
    public let bytes: Data
    public let width: Int
    public let height: Int
    public let mime: String

    public init(bytes: Data, width: Int, height: Int, mime: String) {
        self.bytes = bytes
        self.width = width
        self.height = height
        self.mime = mime
    }
}

@MainActor
public enum ScreenshotCapture {

    public struct Result {
        public let image: UIImage
        public let widthPoints: CGFloat
        public let heightPoints: CGFloat
        public let scale: CGFloat
        public let pngData: Data
    }

    /// `CGImage` is immutable and safe to hand to another executor, but is not
    /// formally `Sendable`; this box carries it across the encode hop without
    /// silencing the check globally.
    private struct UncheckedBox: @unchecked Sendable {
        let value: CGImage
        init(_ value: CGImage) { self.value = value }
    }

    /// Max output dimension (longer edge). RESEARCH Finding 2 — caps multipart payload size.
    public static let MAX_EDGE_PT: CGFloat = 2048.0

    /// Default longest edge for a live-preview frame. Spec 2026-07-17 §3
    /// budgets ~480p-class JPEG at 1–2 fps; a report-grade frame at that rate
    /// would blow the relay's per-pair byte cap several times over while
    /// pinning the device's CPU for pixels discarded half a second later.
    public static let PREVIEW_MAX_EDGE_PT: CGFloat = 854.0

    /// Default JPEG quality for a live-preview frame (spec: ~0.6).
    public static let PREVIEW_QUALITY: CGFloat = 0.6

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
    /// PRIV-03 ordering lives, shared by the report path and the preview path
    /// so there are not two copies of it to drift apart.
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
        // (`.background(Color.black.ignoresSafeArea())` or similar). The SDK
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

    // MARK: - Live preview (companion multi-shot, spec 2026-07-17 §3)

    /// Preview-grade capture of `window`: same acquisition and the same
    /// PRIV-03 bake as the report path, at the preview's own much smaller cap,
    /// JPEG-encoded.
    ///
    /// Sensitive-rect baking still applies, and matters MORE here rather than
    /// less: a preview streams the live screen to another human's browser.
    ///
    /// The render runs on the main actor (it touches the view hierarchy); the
    /// ENCODE is pushed off it. At 2 fps for up to two minutes that is worth
    /// doing — the Android twin ran scale-plus-encode on the UI thread every
    /// 500 ms, which an emulator backed by a desktop CPU never surfaces and a
    /// mid-range phone does.
    public static func capturePreviewFrame(window: UIWindow,
                                           blackoutRects: [CGRect],
                                           maxEdgePt: CGFloat = PREVIEW_MAX_EDGE_PT,
                                           quality: CGFloat = PREVIEW_QUALITY) async -> PreviewCapture? {
        // Preview frames are display-only and never become report evidence, so
        // scale 1.0 rather than the screen's: a Retina-scale 854pt frame is
        // several times the bytes for pixels the phone downsamples into a
        // thumbnail anyway.
        guard let image = renderMasked(bounds: window.bounds,
                                       scale: 1.0,
                                       maxEdge: maxEdgePt,
                                       blackoutRects: blackoutRects,
                                       drawContent: { bounds in
                                           window.drawHierarchy(in: bounds, afterScreenUpdates: true)
                                       }),
              let cgImage = image.cgImage
        else { return nil }
        return await encodePreviewJPEG(cgImage, quality: quality)
    }

    /// JPEG-encodes off the main actor. Split out so both the window path above
    /// and tests share one encode.
    static func encodePreviewJPEG(_ cgImage: CGImage, quality: CGFloat) async -> PreviewCapture? {
        let width = cgImage.width
        let height = cgImage.height
        let box = UncheckedBox(cgImage)
        let bytes = await Task.detached(priority: .userInitiated) {
            UIImage(cgImage: box.value).jpegData(compressionQuality: quality)
        }.value
        guard let bytes else { return nil }
        return PreviewCapture(bytes: bytes, width: width, height: height, mime: "image/jpeg")
    }

    /// Production entry point — resolves the host's foreground window itself.
    ///
    /// iOS needs no host-installed provider seam for this, unlike the Android
    /// core AAR which cannot resolve an Activity and must be handed one by the
    /// RN module. That difference is why there is no iOS equivalent of
    /// Android's `__previewProvider`.
    public static func capturePreviewFrame(maxEdgePt: CGFloat = PREVIEW_MAX_EDGE_PT,
                                           quality: CGFloat = PREVIEW_QUALITY) async -> PreviewCapture? {
        guard let window = activeKeyWindow() else { return nil }
        let rects = SensitiveRectRegistry.collectSensitiveRects(in: window)
        return await capturePreviewFrame(window: window, blackoutRects: rects,
                                         maxEdgePt: maxEdgePt, quality: quality)
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
    /// (`UIApplication.shared.connectedScenes` is empty; see
    /// `CompanionBadgeTests.swift`'s file header for the same constraint),
    /// so `activeKeyWindow()`'s real window source can't be driven from a
    /// host-runnable test. When set, `activeKeyWindow()` filters/sorts THIS
    /// list instead of querying `UIApplication.shared` — lets finding N4's
    /// badge-window-exclusion be asserted deterministically with plain
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
        // External review, finding N4 — filter out the companion badge's own
        // overlay window BEFORE the level sort runs. The level-ordering
        // heuristic below picks the LOWEST-level visible window as a proxy
        // for "the host's main window", which breaks the moment the host's
        // real window is only TRANSIENTLY hidden (a scene transition, a host
        // animating its window out and back): with the host window
        // momentarily `isHidden`, the badge's own overlay becomes the lowest
        // surviving candidate and every capture path routing through this
        // method (screenshot, VTree, UITree, preview) resolves to an SDK
        // overlay instead of the host's UI. Capture must never resolve to an
        // SDK overlay window even when it is momentarily the only visible
        // one — the level rule below remains the tie-breaker for ordinary
        // host layering, it just never gets to see this window at all.
        let nonBadgeCandidates = candidates.filter { !($0 is TXCompanionBadgeWindow) }
        // Lowest windowLevel = host's main window. Tie-breaker: prefer the
        // current isKeyWindow if multiple windows share that level.
        return nonBadgeCandidates
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
