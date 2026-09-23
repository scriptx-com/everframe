// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.rn

import android.view.View
import dev.everframe.Everframe
import dev.everframe.capture.video.VideoPrivacyAdapter
import dev.everframe.capture.video.VideoPrivacyAdapter.Classification

/** Reads native mount-time RN state; never treats a caller nativeID as authorization. */
internal object RnVideoPrivacyAdapter : VideoPrivacyAdapter {
    override fun classify(view: View): Classification = try {
        if (view.getTag(com.facebook.react.R.id.view_tag_native_id) == "everframe-sensitive")
            Classification.EXCLUDE else Classification.ORDINARY_VIEW
    } catch (_: Throwable) { Classification.UNKNOWN }
}

/** One process-lifetime scalar token: module invalidation cannot prove native surface detach. */
internal object RnVideoPrivacyUncertainty {
    private var retained: AutoCloseable? = null
    @Synchronized fun retain(token: AutoCloseable) {
        if (retained == null) retained = token else token.close()
    }
}

/** One latched uncertainty/token per RN instance, with scalar outstanding work accounting. */
internal class RnSensitiveRegistration(
    private val resolve: (Int) -> View?,
    private val dispatch: (() -> Unit) -> Unit,
) : AutoCloseable {
    private var token: AutoCloseable? = null
    private var outstanding = 0L
    private var uncertain = false
    private var destroyed = false

    @Synchronized fun register(tag: Double) {
        if (destroyed) return
        if (token == null) token = Everframe.__beginSensitiveRegistration()
        if (!tag.isFinite() || tag <= 0 || tag > Int.MAX_VALUE || tag != tag.toInt().toDouble()) {
            uncertain = true; return
        }
        outstanding++
        try {
            dispatch {
                synchronized(this) {
                    if (destroyed) return@synchronized
                    try {
                        val view = resolve(tag.toInt())
                        if (view == null) uncertain = true else {
                            Everframe.markSensitive(view)
                            if (view.getTag(dev.everframe.R.id.tx_sensitive) != true) uncertain = true
                        }
                    } catch (_: Throwable) { uncertain = true }
                    outstanding--
                    if (outstanding == 0L && !uncertain) { token?.close(); token = null }
                }
            }
        } catch (_: Throwable) { outstanding--; uncertain = true }
    }
    @Synchronized override fun close() {
        destroyed = true
        token?.let(RnVideoPrivacyUncertainty::retain); token = null
    }
}
