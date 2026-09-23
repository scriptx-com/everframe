// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Host-installed reporter trigger lives on this screen for parity with
// Login / Payment (Plan 05-09 — closes UAT Test 3 gap reachability for
// PRIV-03 idioms past the list screen).
package com.example.composesample.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.everframe.Everframe
import dev.everframe.config.ReportResult

@Composable
fun SampleDetailScreen(itemId: Int, onBack: () -> Unit) {
    val isPresenting by Everframe.report.isPresenting.collectAsState()

    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Text("Sample Detail — Item #$itemId")
        Spacer(modifier = Modifier.height(8.dp))
        Text("Lorem ipsum sample body. Tap the button below to open the reporter.")
        Spacer(modifier = Modifier.height(24.dp))

        // Host-installed reporter trigger (Plan 05-09) — parity with Login/Payment.
        Button(
            onClick = {
                Everframe.report.openAsync(object : Everframe.Callback<ReportResult> {
                    override fun onResult(value: ReportResult) { /* no-op */ }
                    override fun onError(error: Throwable) { /* no-op */ }
                })
            },
            enabled = !isPresenting,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Open Everframe reporter")
        }
        Spacer(modifier = Modifier.height(8.dp))

        OutlinedButton(onClick = onBack) { Text("Back") }
    }
}
