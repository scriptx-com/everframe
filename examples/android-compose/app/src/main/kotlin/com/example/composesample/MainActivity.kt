// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TraceItX Compose sample — phone/tablet entry point (Plan 05-08).
//
// Demonstrates the full public surface:
//   • TraceItX.start(this, config) in onCreate (synchronous, returns in <5ms)
//   • Bubble auto-attaches to decor view via :traceitx-reporter-ui's startup Initializer
//   • Modifier.txSensitive() in LoginScreen marks the password field as sensitive
//     (PRIV-03: bake-black redaction in screenshots)
//   • TraceItX.markSensitive(view) in PaymentScreen marks the credit-card EditText
//     interop view as sensitive (View-tree path)
//   • OkHttpClient.Builder.addTraceItXInterceptor() in NetworkRepo demonstrates
//     network capture wiring
//   • report.open() / report.openAsync(callback) — both forms exercised
package com.example.composesample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.example.composesample.screens.SampleDetailScreen
import com.example.composesample.screens.SampleListScreen
import com.example.composesample.screens.SampleLoginScreen
import com.example.composesample.screens.SamplePaymentScreen
import com.example.composesample.screens.SamplePlaybackScreen
import com.traceitx.CaptureExceptionOptions
import com.traceitx.ErrorSeverity
import com.traceitx.TXScreen
import com.traceitx.TraceItX
import com.traceitx.config.Environment
import com.traceitx.config.TraceItXConfig

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. TraceItX.start — synchronous, must return in <5ms (PERF-01).
        //    Plan 05.1-02 stripped the bubble + shake + TV trigger machinery from
        //    the SDK; trigger detection is host-app responsibility now. The
        //    `bubble = true` flag below is just a hint (see TraceItXConfig KDoc).
        // Ingest URL is baked into the SDK at build time per Gradle variant:
        //   release AAR → https://traceitx.com
        //   debug AAR   → $TRACEITX_DEV_INGEST_URL env or http://10.0.2.2:8787 (emulator → host)
        TraceItX.start(
            this,
            TraceItXConfig(
                appId = "compose-sample",
                sdkKey = BuildConfig.TRACEITX_SDK_KEY,
                environment = Environment.development,
                bubble = true,
            ),
        )

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    SampleNav()
                }
            }
        }
    }
}

private sealed interface SampleRoute {
    data object List : SampleRoute
    data class Detail(val id: Int) : SampleRoute
    data object Login : SampleRoute
    data object Payment : SampleRoute
    data object Playback : SampleRoute
}

@Composable
private fun SampleNav() {
    var route by remember { mutableStateOf<SampleRoute>(SampleRoute.List) }
    Scaffold(
        bottomBar = {
            Button(
                onClick = {
                    TraceItX.captureException(
                        IllegalStateException("Compose sample handled warning"),
                        CaptureExceptionOptions(
                            severity = ErrorSeverity.WARNING,
                            context = "compose-sample.manual-validation",
                            metadata = mapOf(
                                "screen" to route.javaClass.simpleName,
                                "synthetic" to true,
                                "attempt" to 1,
                            ),
                        ),
                    )
                },
                modifier = Modifier.padding(16.dp),
            ) {
                Text("Report handled error")
            }
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when (val r = route) {
                is SampleRoute.List -> {
                    TXScreen(name = "List")
                    SampleListScreen(
                        onItemClick = { id -> route = SampleRoute.Detail(id) },
                        onLogin = { route = SampleRoute.Login },
                        onPayment = { route = SampleRoute.Payment },
                        onPlayback = { route = SampleRoute.Playback },
                    )
                }
                is SampleRoute.Detail -> {
                    TXScreen(name = "Detail")
                    SampleDetailScreen(itemId = r.id, onBack = { route = SampleRoute.List })
                }
                SampleRoute.Login -> {
                    TXScreen(name = "Login")
                    SampleLoginScreen(onBack = { route = SampleRoute.List })
                }
                SampleRoute.Payment -> {
                    TXScreen(name = "Payment")
                    SamplePaymentScreen(onBack = { route = SampleRoute.List })
                }
                SampleRoute.Playback -> {
                    TXScreen(name = "Playback")
                    SamplePlaybackScreen(onBack = { route = SampleRoute.List })
                }
            }
        }
    }
}
