// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SampleListScreen — Plan 05-08 R8 release-minified APK string-survival gate
// greps for "SampleListScreen" in `strings -a *.apk` to prove that R8 / Compose
// keep rules preserve composable function names. Renaming this composable
// breaks the gate.
package com.example.composesample.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.everframe.Everframe
import kotlinx.coroutines.launch

private data class FakeItem(val id: Int, val title: String, val subtitle: String)

private val fakeItems: List<FakeItem> = (1..20).map { i ->
    FakeItem(id = i, title = "Item #$i", subtitle = "Sample row $i for the Everframe dogfood demo")
}

@Composable
fun SampleListScreen(
    onItemClick: (Int) -> Unit,
    onLogin: () -> Unit,
    onPayment: () -> Unit,
    onPlayback: () -> Unit,
) {
    // Plan 05.1-02: host-installed reporter trigger. The SDK no longer ships
    // a bubble or shake; sample apps demonstrate the recommended phone recipe —
    // an in-screen Button that calls report.open() and disables itself while
    // the reporter is presenting (via the new isPresenting StateFlow).
    val isPresenting by Everframe.report.isPresenting.collectAsState()
    val scope = rememberCoroutineScope()

    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Text("Everframe Sample — Phone/Tablet")
        Spacer(modifier = Modifier.height(8.dp))
        Button(
            onClick = { scope.launch { runCatching { Everframe.report.open() } } },
            enabled = !isPresenting,
        ) { Text("Open Everframe reporter") }
        Button(onClick = {
            try {
                error("Native Android handled error test")
            } catch (error: IllegalStateException) {
                Everframe.captureException(error)
            }
        }) { Text("Report handled error") }
        Spacer(modifier = Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onLogin) { Text("Login (Modifier.txSensitive)") }
            OutlinedButton(onClick = onPayment) { Text("Payment (markSensitive view)") }
            OutlinedButton(onClick = onPlayback) { Text("Playback (Session Vitals)") }
        }
        Spacer(modifier = Modifier.height(16.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(fakeItems, key = { it.id }) { item ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onItemClick(item.id) }
                        .padding(vertical = 8.dp),
                ) {
                    Column {
                        Text(item.title)
                        Text(item.subtitle)
                    }
                }
            }
        }
    }
}
