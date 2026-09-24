// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Per RESEARCH Finding 6 — capture-before-reporter ordering: PixelCopy.request
// is invoked BEFORE the reporter Dialog/Activity is constructed; self-capture
// is impossible because the reporter does not yet exist. Plan 06 owns the
// ordering invariant in TXReporterPresenter; this file owns the
// bake-after-PixelCopy invariant only (PRIV-03).
//
// Mirrors `packages/sdk-ios/Sources/Everframe/Capture/ScreenshotCapture.swift`.
// The iOS analog uses UIGraphicsImageRenderer + drawHierarchy(); on Android
// PixelCopy.request is the canonical equivalent — captures the actual rendered
// pixels of the host's window (including hardware-accelerated surfaces, with
// the documented SurfaceView caveat — see 05-03-SUMMARY.md).
//
// Caveats:
//   • SurfaceView / hardware-accelerated VideoView render as black on PixelCopy
//     when the source is `Window` (RESEARCH Finding 6). Documented limitation;
//     v1.2 ships as-is. Envelope-level degradedReason is added by Plan 06 when
//     the customer opts into surface-aware capture (Plan 09 carry-forward).

package dev.everframe.capture

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import dev.everframe.companion.PreviewCapture
import dev.everframe.envelope.txGuardSuspend
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

// Visibility: `public` (Plan 05-06 cross-module entry) — :reporter-ui's
// TXReporterPresenter calls `captureBeforeReporter` directly. The internal-access
// boundary inside :everframe-core is enforced by package convention; cross-module
// access is via this single public entry point.
object ScreenshotCapture {

    /** Max output dimension (longer edge). Mirrors iOS MAX_EDGE_PT. PIPE-03. */
    internal const val MAX_EDGE_PX: Int = 2048

    data class CaptureResult(
        val bitmap: Bitmap,
        val widthPx: Int,
        val heightPx: Int,
        val pngBytes: ByteArray,
    ) {
        // ByteArray equals/hashCode are identity-based by default; override so
        // tests can do data-class equality without surprises.
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is CaptureResult) return false
            return widthPx == other.widthPx &&
                heightPx == other.heightPx &&
                pngBytes.contentEquals(other.pngBytes)
        }

        override fun hashCode(): Int =
            (widthPx * 31 + heightPx) * 31 + pngBytes.contentHashCode()
    }

    /**
     * Capture the host Activity window's pixels via PixelCopy, bake sensitive
     * rects black PRE-encode, downscale to fit MAX_EDGE_PX, return PNG bytes.
     *
     * Returns null on any failure (DEFE-02 soft-degrade — caller ships envelope
     * without a screenshot).
     */
    suspend fun captureBeforeReporter(
        activity: Activity,
        sensitiveRects: List<Rect> = emptyList(),
    ): CaptureResult? = txGuardSuspend("screenshot") {
        val srcBitmap = acquireBakedWindowBitmap(activity, sensitiveRects)
            ?: return@txGuardSuspend null

        // Task 11b review, finding 3 — same reasoning as capturePreviewFrame
        // below, and it bites harder here: a shot request runs this on
        // `CompanionPreviewSession`'s Main scope, and a PNG encode at quality
        // 100 of a ~1.9 MP bitmap is hundreds of milliseconds of UI-thread
        // stall on mid-range hardware.
        withContext(Dispatchers.Default) {
            val w = srcBitmap.width
            val h = srcBitmap.height

            // Downscale if longer edge exceeds MAX_EDGE_PX (PIPE-03 input shaping).
            val maxEdge = maxOf(w, h)
            val finalBitmap: Bitmap = if (maxEdge > MAX_EDGE_PX) {
                val scale = MAX_EDGE_PX.toFloat() / maxEdge
                val tw = (w * scale).toInt().coerceAtLeast(1)
                val th = (h * scale).toInt().coerceAtLeast(1)
                val scaled = Bitmap.createScaledBitmap(srcBitmap, tw, th, true)
                srcBitmap.recycle()
                scaled
            } else {
                srcBitmap
            }

            val baos = ByteArrayOutputStream()
            finalBitmap.compress(Bitmap.CompressFormat.PNG, 100, baos)
            // NOT recycled here, unlike capturePreviewFrame: `CaptureResult`
            // hands this bitmap to the caller, which owns it from here on.
            CaptureResult(
                bitmap = finalBitmap,
                widthPx = finalBitmap.width,
                heightPx = finalBitmap.height,
                pngBytes = baos.toByteArray(),
            )
        }
    }

    /**
     * A preview frame: same PixelCopy acquisition as `captureBeforeReporter`,
     * then downscaled to `maxEdgePx` and JPEG-encoded at `quality`.
     *
     * Deliberately NOT PNG at MAX_EDGE_PX like the report path — spec
     * 2026-07-17 §3 budgets ~480p JPEG at quality ~0.6 for 1-2 fps, and a
     * report-grade frame at that rate would exceed the relay's per-pair byte
     * cap several times over while pinning the device's CPU for pixels that
     * are discarded a half-second later.
     *
     * Sensitive-rect baking still applies: a preview streams the live screen
     * to another human's browser, so masking matters MORE here, not less.
     *
     * Returns null on any failure (DEFE-02 soft-degrade — the session stops
     * with `capture_unavailable` rather than crashing a report). This is
     * `CompanionCaptureBridge.__previewProvider`'s implementation, installed
     * by `EverframeModule.startCompanion` (Task 11b).
     */
    suspend fun capturePreviewFrame(
        activity: Activity,
        sensitiveRects: List<Rect> = emptyList(),
        maxEdgePx: Int = 854,
        quality: Int = 60,
    ): PreviewCapture? = txGuardSuspend("screenshot-preview") {
        val srcBitmap = acquireBakedWindowBitmap(activity, sensitiveRects)
            ?: return@txGuardSuspend null

        // Task 11b review, finding 3: the scale and the encode move OFF the
        // caller's thread. `CompanionPreviewSession`'s scope is
        // `Dispatchers.Main`, so this ran `createScaledBitmap` plus a JPEG
        // encode on the UI thread every 500 ms for up to two minutes. An x86
        // emulator on a desktop CPU never shows it; a mid-range phone does.
        // Only the post-acquisition work moves — the rect walk and
        // `PixelCopy.request` above must stay where the caller put them.
        withContext(Dispatchers.Default) {
            val w = srcBitmap.width
            val h = srcBitmap.height

            // Downscale if longer edge exceeds maxEdgePx (same shaping rule as
            // captureBeforeReporter, at the preview's own — much smaller — cap).
            val maxEdge = maxOf(w, h)
            val finalBitmap: Bitmap = if (maxEdge > maxEdgePx) {
                val scale = maxEdgePx.toFloat() / maxEdge
                val tw = (w * scale).toInt().coerceAtLeast(1)
                val th = (h * scale).toInt().coerceAtLeast(1)
                val scaled = Bitmap.createScaledBitmap(srcBitmap, tw, th, true)
                srcBitmap.recycle()
                scaled
            } else {
                srcBitmap
            }

            val baos = ByteArrayOutputStream()
            finalBitmap.compress(Bitmap.CompressFormat.JPEG, quality, baos)
            val outWidth = finalBitmap.width
            val outHeight = finalBitmap.height
            // Task 11b review, finding 1: recycled once the bytes are out.
            // Nothing downstream holds this bitmap — PreviewCapture carries
            // only the encoded bytes — and at ~2 frames/second a session
            // otherwise leaves ~240 full-window ARGB_8888 allocations (~10 MB
            // each at 1080x2400) for the GC to chase. Reclaimable rather than
            // leaked, which is exactly why it never showed up in a short run.
            finalBitmap.recycle()
            PreviewCapture(
                bytes = baos.toByteArray(),
                width = outWidth,
                height = outHeight,
                mime = "image/jpeg",
            )
        }
    }

    /**
     * Shared by [captureBeforeReporter] and [capturePreviewFrame]: acquire the
     * host Activity window's pixels via PixelCopy into a full-window-sized
     * bitmap, then bake sensitive rects black PRE-encode (PRIV-03). Callers
     * diverge only on what happens AFTER this — downscale target and encode
     * format. Returns null on any failure (missing window, zero-size window,
     * or a failed/thrown PixelCopy request) so both callers share one
     * DEFE-02 soft-degrade path instead of two copies of it.
     */
    private suspend fun acquireBakedWindowBitmap(
        activity: Activity,
        sensitiveRects: List<Rect>,
    ): Bitmap? {
        val window = activity.window ?: return null
        val src = window.decorView
        val w = src.width
        val h = src.height
        if (w <= 0 || h <= 0) return null

        // Pre-allocate at full window size — PixelCopy writes into this bitmap
        // 1:1 with window pixels. Downscale happens AFTER bake (so blackout
        // rects stay in window-coordinate space and blackout precision is not
        // limited by the downscaled raster).
        val srcBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val pixelCopyOk = suspendCancellableCoroutine<Boolean> { cont ->
            try {
                PixelCopy.request(
                    window,
                    srcBitmap,
                    { result -> cont.resume(result == PixelCopy.SUCCESS) },
                    Handler(Looper.getMainLooper()),
                )
            } catch (t: Throwable) {
                cont.resume(false)
            }
        }
        if (!pixelCopyOk) {
            srcBitmap.recycle()
            return null
        }

        // PRIV-03: bake sensitive rects BEFORE encode. Bake on the full-size
        // bitmap so coords match window space directly.
        if (sensitiveRects.isNotEmpty()) {
            applySensitiveMask(srcBitmap, sensitiveRects)
        }
        return srcBitmap
    }

    /** Visible-for-testing — bake opaque black rects on the bitmap in-place. */
    internal fun applySensitiveMask(bitmap: Bitmap, rects: List<Rect>) {
        val canvas = Canvas(bitmap)
        val paint = Paint().apply {
            color = Color.BLACK
            style = Paint.Style.FILL
        }
        for (r in rects) canvas.drawRect(r, paint)
    }

    /**
     * Capture only [regionPx] (WINDOW-coordinate space) of the host
     * Activity's window, via the API-26 `PixelCopy.request(Window, Rect,
     * Bitmap, ...)` srcRect overload — Task 8 (area capture). Clones
     * [captureBeforeReporter]'s pipeline (pre-allocated bitmap →
     * suspendCancellableCoroutine → PRIV-03 mask BEFORE downscale →
     * MAX_EDGE_PX downscale → PNG encode) at the region's own size instead
     * of the full window.
     *
     * Same catch-and-degrade contract as `captureBeforeReporter` (DEFE-02):
     * the try/catch around `PixelCopy.request` covers both a genuinely
     * missing overload on minSdk-24/25 devices (surfaces as
     * `NoSuchMethodError` at the call site) and any other runtime failure —
     * either way `cont.resume(false)` degrades to a null [CaptureResult]
     * rather than crashing the reporter flow.
     */
    suspend fun captureRegion(
        activity: Activity,
        regionPx: Rect,
        sensitiveRects: List<Rect> = emptyList(),
    ): CaptureResult? = txGuardSuspend("screenshot-region") {
        val window = activity.window ?: return@txGuardSuspend null
        val decor = window.decorView

        // Review finding 1 (Task 8): PixelCopy.request CLAMPS an
        // out-of-bounds srcRect to the window's own bounds natively —
        // silently — and still reports SUCCESS. If [regionPx] were passed
        // through unclamped, the bitmap below would be pre-allocated at the
        // UNCLAMPED (caller-requested) size while PixelCopy only paints the
        // clamped sub-rect into it, leaving a partially-transparent bitmap
        // that ships as if it were a real capture — and the PRIV-03
        // sensitive-rect translation below (which assumes regionPx IS the
        // captured rect) would offset against the wrong origin/size,
        // risking a misaligned mask. Clamp FIRST, against the actual
        // window bounds, and use the clamped rect for every downstream
        // step (allocation, PixelCopy, sensitive-rect translation) so
        // there is no unclamped value left to accidentally reach any of
        // them. Mirrors iOS's `intersection(imagePixelBounds)` guard in
        // AreaCropMath.
        val clampedRegion = clampRegionToWindow(regionPx, decor.width, decor.height)
            ?: return@txGuardSuspend null
        val w = clampedRegion.width()
        val h = clampedRegion.height()
        if (w <= 0 || h <= 0) return@txGuardSuspend null

        // Pre-allocate at region size — the srcRect overload writes only
        // the requested window-coordinate sub-rect into this bitmap.
        val srcBitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val pixelCopyOk = suspendCancellableCoroutine<Boolean> { cont ->
            try {
                // API 26+ srcRect overload — same catch-and-degrade contract
                // as captureBeforeReporter's window overload (DEFE-02). On
                // API 24-25 this throws (no such overload exists) and is
                // caught below, exactly like the window overload's own
                // failure path.
                PixelCopy.request(
                    window,
                    clampedRegion,
                    srcBitmap,
                    { result -> cont.resume(result == PixelCopy.SUCCESS) },
                    Handler(Looper.getMainLooper()),
                )
            } catch (t: Throwable) {
                cont.resume(false)
            }
        }
        if (!pixelCopyOk) {
            srcBitmap.recycle()
            return@txGuardSuspend null
        }

        // PRIV-03: bake sensitive rects BEFORE encode, same invariant as
        // captureBeforeReporter. Sensitive rects arrive in WINDOW coords
        // (same space SensitiveRectRegistry always reports in) — translate
        // into region-local space first: rects outside the region are
        // dropped, rects straddling the boundary are clipped. Uses the
        // CLAMPED region so the translation origin matches the bitmap
        // PixelCopy actually painted into.
        val translated = translateSensitiveRects(sensitiveRects, clampedRegion)
        if (translated.isNotEmpty()) applySensitiveMask(srcBitmap, translated)

        // Downscale if longer edge exceeds MAX_EDGE_PX (PIPE-03 input shaping).
        val maxEdge = maxOf(w, h)
        val finalBitmap: Bitmap = if (maxEdge > MAX_EDGE_PX) {
            val scale = MAX_EDGE_PX.toFloat() / maxEdge
            val tw = (w * scale).toInt().coerceAtLeast(1)
            val th = (h * scale).toInt().coerceAtLeast(1)
            val scaled = Bitmap.createScaledBitmap(srcBitmap, tw, th, true)
            srcBitmap.recycle()
            scaled
        } else {
            srcBitmap
        }

        val baos = ByteArrayOutputStream()
        finalBitmap.compress(Bitmap.CompressFormat.PNG, 100, baos)
        CaptureResult(
            bitmap = finalBitmap,
            widthPx = finalBitmap.width,
            heightPx = finalBitmap.height,
            pngBytes = baos.toByteArray(),
        )
    }

    /**
     * Visible-for-testing pure function — intersect [region] (WINDOW-coordinate
     * space, caller-supplied and untrusted) against the actual window bounds
     * `[0, 0, windowWidth, windowHeight)`, returning the clamped rect, or
     * `null` when the intersection is empty (region entirely off-window).
     *
     * `Rect.intersect` mutates its receiver, so [region] is copied (`Rect(region)`)
     * before mutating — the caller's original instance is never touched, same
     * convention as [translateSensitiveRects]. Called at the very top of
     * [captureRegion] (review finding 1) so every downstream step — bitmap
     * allocation, the PixelCopy request itself, and the PRIV-03 sensitive-rect
     * translation — operates on the CLAMPED rect instead of a value
     * PixelCopy might silently reinterpret on its own.
     */
    internal fun clampRegionToWindow(region: Rect, windowWidth: Int, windowHeight: Int): Rect? {
        val clamped = Rect(region)
        return if (clamped.intersect(0, 0, windowWidth, windowHeight)) clamped else null
    }

    /**
     * Visible-for-testing pure function — translate WINDOW-coordinate
     * [sensitive] rects into [region]-local coordinates ahead of
     * [captureRegion]'s bake step.
     *
     * `Rect.intersect` mutates its receiver, so each candidate is copied
     * (`Rect(r)`) before mutating — the caller's original [sensitive] list
     * is never touched. Rects that don't intersect [region] at all
     * (including rects that only touch its boundary — `Rect.intersect`
     * treats a shared edge with zero overlapping area as non-intersecting)
     * are DROPPED; intersecting rects are CLIPPED to the region first, then
     * offset by `-region.left, -region.top` so (0,0) in the result matches
     * the region's own top-left corner — the same coordinate origin the
     * region-sized `srcBitmap` in [captureRegion] uses.
     */
    internal fun translateSensitiveRects(sensitive: List<Rect>, region: Rect): List<Rect> =
        sensitive.mapNotNull { r ->
            val clipped = Rect(r)
            if (clipped.intersect(region)) {
                clipped.offset(-region.left, -region.top)
                clipped
            } else {
                null
            }
        }
}
