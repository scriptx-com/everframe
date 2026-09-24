// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-08 Task 2 — sample-app demonstration of Everframe companion
// state. Phones scan the QR, pair, and trigger reports from the phone
// reporter; the TV (or any Android target) renders the QR via a host-
// provided QR library. The SDK never ships QR rendering — that's the
// host's job per CONTEXT D-04 (T-06.2-08-04 mitigation).
//
// What this Activity shows:
//   • Collect `Everframe.companion.pairUrl` on `lifecycleScope` (per
//     plan-checker W2 — Activity-scoped, NOT GlobalScope).
//   • Render the URL as a QR bitmap via ZXing (host-app dependency,
//     declared in `app/build.gradle.kts` ONLY).
//   • Collect `Everframe.companion.state` to swap a status line below
//     the QR.
//
// Note: the sample namespace is `com.example.viewssample` (matches the
// `AndroidManifest.xml` + `applicationId` in `app/build.gradle.kts`).
// The plan's draft path `com.example.tracedemo` is illustrative only.
package com.example.viewssample

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import dev.everframe.Everframe
import dev.everframe.companion.CompanionState
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

class CompanionQRActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_companion_qr)

        val qrView = findViewById<ImageView>(R.id.qr_image)
        val statusView = findViewById<TextView>(R.id.status_text)
        val nameView = findViewById<TextView>(R.id.name_text)

        // Gate the QR on STATE, not on pairUrl. The SDK retains pairUrl after
        // bond (it's nulled only on socket close), so the QR must be torn down
        // when state leaves `Unpaired` — otherwise a bonded phone leaves a
        // stale QR on screen. Combine both flows: show the QR only while
        // Unpaired with a non-null URL, clear it otherwise.
        lifecycleScope.launch {
            combine(Everframe.companion.state, Everframe.companion.pairUrl) { state, url ->
                if (state == CompanionState.Unpaired) url else null
            }.collect { urlForQr ->
                qrView.setImageBitmap(urlForQr?.let { encodeQr(it, dimensionPx = 800) })
            }
        }

        // Mirror status text to the SPEC state-machine surface.
        lifecycleScope.launch {
            Everframe.companion.state.collect { state ->
                statusView.text = when (state) {
                    CompanionState.Unpaired ->
                        "Scan to file a bug report"
                    CompanionState.Paired ->
                        "Phone connected — file from your phone"
                    CompanionState.ReportInProgress ->
                        "Report in progress on phone"
                    CompanionState.PhoneDisconnected ->
                        "Phone disconnected — waiting for reconnect"
                }
            }
        }

        // Server-resolved display name (spec 2026-08-24) lets a dashboard
        // user match this screen to the right row in the Companion list;
        // fall back to the short code when no name has resolved yet. Both
        // share `pairUrl`'s lifecycle, so this stays populated past bond.
        lifecycleScope.launch {
            combine(Everframe.companion.resolvedName, Everframe.companion.code) { name, code ->
                name ?: code?.let { "Code: $it" }
            }.collect { label ->
                nameView.text = label.orEmpty()
            }
        }
    }

    /**
     * Encode `text` as a QR bitmap. Host responsibility — kept in the
     * sample app so the SDK AAR stays library-free (CONTEXT D-04).
     */
    private fun encodeQr(text: String, dimensionPx: Int): Bitmap {
        val hints = mapOf(
            EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M,
            EncodeHintType.MARGIN to 1,
        )
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, dimensionPx, dimensionPx, hints)
        val w = matrix.width
        val h = matrix.height
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        for (y in 0 until h) {
            for (x in 0 until w) {
                bmp.setPixel(x, y, if (matrix.get(x, y)) Color.BLACK else Color.WHITE)
            }
        }
        return bmp
    }
}
