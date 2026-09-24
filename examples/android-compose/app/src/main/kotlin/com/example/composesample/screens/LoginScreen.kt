// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SampleLoginScreen — dogfoods Modifier.txSensitive() on a Compose password field
// (PRIV-03: bake-black mask in captured screenshots). Plan 05-08 R8 gate greps
// for "SampleLoginScreen" in `strings -a *.apk`.
//
// Host-installed reporter trigger lives on this screen so the txSensitive()
// password rect can be exercised end-to-end (Plan 05-09 — closes UAT Test 3
// gap reachability for PRIV-03 idioms past the list screen).
package com.example.composesample.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.everframe.Everframe
import dev.everframe.config.ReportResult
import dev.everframe.sensitive.txSensitive

@Composable
fun SampleLoginScreen(onBack: () -> Unit) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val isPresenting by Everframe.report.isPresenting.collectAsState()

    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Text("Sample Login")
        Spacer(modifier = Modifier.height(8.dp))

        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("Email") },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(modifier = Modifier.height(8.dp))

        // Modifier.txSensitive() — PRIV-03 redaction. The password field's bounds
        // are captured by SensitiveRectRegistry and baked BLACK in the screenshot
        // before bytes ever reach the reporter UI or the network.
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier
                .fillMaxWidth()
                .txSensitive(),
        )
        Spacer(modifier = Modifier.height(16.dp))

        // Host-installed reporter trigger (Plan 05-09). Lets UAT Test 3 exercise
        // PRIV-03 bake-black on the password rect without leaving this screen.
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

        Button(onClick = onBack) { Text("Sign In (demo no-op)") }
        Spacer(modifier = Modifier.height(8.dp))
        OutlinedButton(onClick = onBack) { Text("Back") }
    }
}
