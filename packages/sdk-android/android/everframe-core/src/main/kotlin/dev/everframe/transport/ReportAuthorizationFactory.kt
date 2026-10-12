// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.transport

import android.os.SystemClock
import dev.everframe.Everframe
import dev.everframe.TXCapturedSession
import dev.everframe.capture.video.FrozenReportCapture
import dev.everframe.config.ConfigFetcher
import dev.everframe.config.ReplayConfigProvider
import dev.everframe.config.effectiveNativeVideo
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

object ReportAuthorizationFactory {
    private val pendingConfigClient = OkHttpClient.Builder().callTimeout(10, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()

    fun forCapture(session: TXCapturedSession, capture: FrozenReportCapture?): ReportAuthorization =
        LockedReportAuthorization({ !session.isRevoked }, {
            session.captureConsent && capture != null && capture.matchesSession(session) && capture.replayAllowed()
        })

    /** Flutter's masked VTree does not depend on native video capture policy. */
    fun forHostReplay(session: TXCapturedSession, capture: FrozenReportCapture): ReportAuthorization =
        LockedReportAuthorization({ !session.isRevoked }, {
            session.captureConsent && capture.matchesSession(session) &&
                Everframe.currentReplayConfig().replayEnabled
        })

    suspend fun forPending(
        session: TXCapturedSession,
        endpointAtInitiation: String,
        entryEndpoint: String,
        entrySdkKey: String,
        hostReplay: Boolean = false,
    ): ReportAuthorization {
        // endpointAtInitiation documents the drain snapshot; only the stored route can authorize its media.
        val provider = ReplayConfigProvider.make(baseUrl = entryEndpoint.trimEnd('/').removeSuffix("/api/ingest"), sdkKey = entrySdkKey,
            fetcher = ConfigFetcher { request -> pendingConfigClient.newCall(request).execute() })
        val succeeded = provider.refresh(force = true)
        val authorizedAt = SystemClock.elapsedRealtime()
        val confirmed = if (hostReplay) succeeded && provider.current.replayEnabled
            else effectiveNativeVideo(provider.current, succeeded) != null
        return LockedReportAuthorization({ !session.isRevoked }, {
            session.captureConsent && confirmed && SystemClock.elapsedRealtime() - authorizedAt in 0 until 30_000
        })
    }
}
