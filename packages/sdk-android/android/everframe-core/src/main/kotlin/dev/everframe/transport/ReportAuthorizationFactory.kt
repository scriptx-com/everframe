// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.transport

import android.os.SystemClock
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

    suspend fun forPending(
        session: TXCapturedSession,
        endpointAtInitiation: String,
        entryEndpoint: String,
        entrySdkKey: String,
    ): ReportAuthorization {
        // endpointAtInitiation documents the drain snapshot; only the stored route can authorize its media.
        val provider = ReplayConfigProvider.make(baseUrl = entryEndpoint.trimEnd('/').removeSuffix("/api/ingest"), apiKey = entrySdkKey,
            fetcher = ConfigFetcher { request -> pendingConfigClient.newCall(request).execute() })
        val succeeded = provider.refresh(force = true)
        val authorizedAt = SystemClock.elapsedRealtime()
        val confirmed = effectiveNativeVideo(provider.current, succeeded) != null
        return LockedReportAuthorization({ !session.isRevoked }, {
            session.captureConsent && confirmed && SystemClock.elapsedRealtime() - authorizedAt in 0 until 30_000
        })
    }
}
