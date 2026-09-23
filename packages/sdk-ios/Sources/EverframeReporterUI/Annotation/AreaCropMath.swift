// packages/sdk-ios/Sources/EverframeReporterUI/Annotation/AreaCropMath.swift
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure crop-rect math for Task 9 (area capture). The area-capture overlay's
// own UIWindow spans the same screen as the host window it sits above, so a
// dragged selection rect is expressed in the SAME point-coordinate space as
// `host.bounds` — no separate conversion needed for that part.
//
// What DOES need converting: `ScreenshotCapture.capture(window:)` renders the
// host into a bitmap that may be DOWNSCALED when the host's longer edge
// exceeds `ScreenshotCapture.MAX_EDGE_PT` (RESEARCH Finding 2 — caps
// multipart payload size), and is rendered at the device's screen scale on
// top of that. The crop must land in that bitmap's PIXEL space, not the
// host's point space. UIKit-free (CoreGraphics only) so it's unit-testable
// under plain `swift test`.
import CoreGraphics

/// Maps a selection rect (host window points) to the pixel rect to crop out
/// of the bitmap `ScreenshotCapture.capture(window:)` produced for that same
/// host window.
///
/// - Parameters:
///   - selection: the dragged rect, in host window points (== the area-capture
///     overlay's own view coordinates — both windows span the same screen).
///   - hostBoundsSize: `host.bounds.size` — the window the selection was drawn over.
///   - capturedImageSize: `shot.image.size` — the captured `UIImage`'s size.
///     Already downscaled to `ScreenshotCapture.MAX_EDGE_PT` if the host's
///     longer edge exceeded it; equal to `hostBoundsSize` otherwise.
///   - capturedImageScale: `shot.image.scale` (== `ScreenshotCapture.Result.scale`,
///     the device screen scale the bitmap was rendered at).
/// - Returns: a rect clamped to the captured image's pixel bounds; `.zero` if
///   the selection doesn't intersect the image at all.
public func cropRectInPixels(
    selection: CGRect,
    hostBoundsSize: CGSize,
    capturedImageSize: CGSize,
    capturedImageScale: CGFloat
) -> CGRect {
    guard hostBoundsSize.width > 0, hostBoundsSize.height > 0 else { return .zero }

    // Ratio between the captured bitmap's point-size and the host's
    // point-size — 1.0 when ScreenshotCapture didn't need to downscale.
    let downscaleFactor = capturedImageSize.width / hostBoundsSize.width
    let pxScale = capturedImageScale * downscaleFactor

    let pxRect = CGRect(
        x: selection.origin.x * pxScale,
        y: selection.origin.y * pxScale,
        width: selection.width * pxScale,
        height: selection.height * pxScale
    )
    let imagePixelBounds = CGRect(
        x: 0, y: 0,
        width: capturedImageSize.width * capturedImageScale,
        height: capturedImageSize.height * capturedImageScale
    )
    let clamped = pxRect.intersection(imagePixelBounds)
    return clamped.isNull ? .zero : clamped
}
