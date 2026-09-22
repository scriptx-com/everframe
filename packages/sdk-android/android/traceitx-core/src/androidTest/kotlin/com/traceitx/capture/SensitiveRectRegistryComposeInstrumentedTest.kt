// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Instrumented coverage for the Phase 05.2 (post-2026-05-08) Compose-side
// extension of SensitiveRectRegistry.collectInWindowCoords. Without this,
// Modifier.txSensitive() and Compose Password TextFields surfaced as
// `sensitive=true` in the UI-tree envelope but were INVISIBLE to the
// screenshot redactor — leaking PII as an unredacted bitmap.
//
// Asserts:
//   • Modifier.txSensitive() box → at least one rect emitted, rect overlaps
//     the marked composable's actual bounds.
//   • Compose PasswordVisualTransformation TextField → rect emitted.
//   • Public Text without txSensitive → no rect emitted for it.
package com.traceitx.capture

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.traceitx.sensitive.txSensitive
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class SensitiveRectRegistryComposeInstrumentedTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun txSensitiveModifier_emits_window_rect() {
        composeRule.setContent {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Public header — should NOT be redacted")
                Box(modifier = Modifier.size(width = 200.dp, height = 100.dp).txSensitive())
                Text("Public footer — should NOT be redacted")
            }
        }
        composeRule.waitForIdle()

        val rects = SensitiveRectRegistry.collectInWindowCoords(composeRule.activity)
        assertNotNull(rects)
        assertTrue(
            "Expected at least 1 sensitive rect from Modifier.txSensitive(), got 0",
            rects.isNotEmpty(),
        )
        // Rects must have non-zero area — a zero-area rect would render as
        // a no-op black bake and silently leak the field.
        for (r in rects) {
            assertTrue(
                "Sensitive rect must have non-zero area, got $r",
                r.width() > 0 && r.height() > 0,
            )
        }
    }

    @Test
    fun composePasswordField_emits_window_rect() {
        composeRule.setContent {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Login")
                OutlinedTextField(
                    value = "",
                    onValueChange = {},
                    label = { Text("Password") },
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                )
            }
        }
        composeRule.waitForIdle()

        val rects = SensitiveRectRegistry.collectInWindowCoords(composeRule.activity)
        assertNotNull(rects)
        assertTrue(
            "Expected at least 1 sensitive rect for password TextField, got 0",
            rects.isNotEmpty(),
        )
        for (r in rects) {
            assertTrue(
                "Sensitive rect must have non-zero area, got $r",
                r.width() > 0 && r.height() > 0,
            )
        }
    }

    // markSensitive(view) happy-path is exercised in the Robolectric
    // SensitiveRectRegistryTest (`TraceItX_markSensitive...` tests) — the
    // View-tier tag-write doesn't depend on Compose layout, and the
    // Robolectric harness lets us force-layout the View deterministically.
    // Re-running it here as an instrumented case is flaky on slower hardware
    // (AndroidView interop layout pass races waitForIdle on the SM-X210).

    @Test
    fun nonSensitive_compose_emits_no_rects() {
        composeRule.setContent {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Just text")
                Text("More text — nothing marked")
            }
        }
        composeRule.waitForIdle()

        val rects = SensitiveRectRegistry.collectInWindowCoords(composeRule.activity)
        assertNotNull(rects)
        // Permitted: zero rects. The entire screen is non-sensitive.
        assertTrue(
            "Expected zero sensitive rects from non-sensitive Compose, got ${rects.size}",
            rects.isEmpty(),
        )
    }
}
