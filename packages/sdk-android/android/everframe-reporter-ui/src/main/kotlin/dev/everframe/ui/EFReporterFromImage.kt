// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.ui

import android.app.Activity
import android.graphics.BitmapFactory
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.config.ReportResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Opens the native reporter with a host-rendered, already masked PNG. */
object EFReporterFromImage {
    suspend fun open(activity: Activity, maskedPng: ByteArray): ReportResult {
        if (maskedPng.size !in 8..10_000_000 ||
            !maskedPng.take(8).toByteArray().contentEquals(
                byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)
            )) return ReportResult.Cancelled("invalid_capture")
        val bitmap = withContext(Dispatchers.Default) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(maskedPng, 0, maskedPng.size, bounds)
            if (bounds.outMimeType != "image/png" ||
                bounds.outWidth <= 0 || bounds.outHeight <= 0 ||
                maxOf(bounds.outWidth, bounds.outHeight) > 2048) null
            else BitmapFactory.decodeByteArray(maskedPng, 0, maskedPng.size)
        } ?: return ReportResult.Cancelled("invalid_capture")
        val capture = ScreenshotCapture.CaptureResult(
            bitmap = bitmap,
            widthPx = bitmap.width,
            heightPx = bitmap.height,
            pngBytes = maskedPng,
        )
        return TXReporterPresenter(
            captureScreenshot = { _, _ -> capture },
            showDialog = { host, screenshot, frozen, extra ->
                ReporterDialog.show(host, screenshot, frozen, extra, allowAdditionalScreenshots = false)
            },
        ).openReporter(activity)
    }
}
