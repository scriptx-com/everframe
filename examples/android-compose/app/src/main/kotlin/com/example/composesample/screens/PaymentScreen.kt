// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SamplePaymentScreen — dogfoods TraceItX.markSensitive(view) on an interop
// EditText (View-tree path), report.openAsync(Callback) for the Java-shim
// surface, and the OkHttpClient.Builder.addTraceItXInterceptor() network
// demo. Plan 05-08 R8 gate greps for "SamplePaymentScreen".
package com.example.composesample.screens

import android.text.InputType
import android.widget.EditText
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.example.composesample.data.NetworkRepo
import com.traceitx.TraceItX
import com.traceitx.config.ReportResult
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

@Composable
fun SamplePaymentScreen(onBack: () -> Unit) {
    val cardEditText = remember { mutableStateOf<EditText?>(null) }
    val openResult = remember { mutableStateOf<String?>(null) }
    val isPresenting by TraceItX.report.isPresenting.collectAsState()

    LaunchedEffect(cardEditText.value) {
        cardEditText.value?.let { v ->
            // Mark the credit-card EditText as sensitive — its bounds are masked in
            // captured screenshots.
            TraceItX.markSensitive(v)
        }
    }

    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Text("Sample Payment")
        Spacer(modifier = Modifier.height(8.dp))

        // AndroidView interop — a real EditText that we hand to TraceItX.markSensitive.
        AndroidView(
            factory = { ctx ->
                EditText(ctx).apply {
                    hint = "Card number (markSensitive)"
                    inputType = InputType.TYPE_CLASS_NUMBER
                }
            },
            update = { cardEditText.value = it },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(modifier = Modifier.height(16.dp))

        // OkHttp + addTraceItXInterceptor() demo — fires a request the SDK observes.
        Button(onClick = { MainScope().launch { NetworkRepo.demoFetch() } }) {
            Text("Fetch demo URL via OkHttp + addTraceItXInterceptor()")
        }
        Spacer(modifier = Modifier.height(8.dp))

        // report.openAsync(Callback) — Java-friendly callback shim surface.
        // Plan 05-09: disable while presenting, mirroring ListScreen's two-line idiom.
        Button(
            onClick = {
                TraceItX.report.openAsync(object : TraceItX.Callback<ReportResult> {
                    override fun onResult(value: ReportResult) {
                        openResult.value = "result=$value"
                    }
                    override fun onError(error: Throwable) {
                        openResult.value = "error=${error.message}"
                    }
                })
            },
            enabled = !isPresenting,
        ) {
            Text("Open reporter via report.openAsync(...)")
        }
        openResult.value?.let { Text(it) }

        Spacer(modifier = Modifier.height(16.dp))
        OutlinedButton(onClick = onBack) { Text("Back") }
    }
}
