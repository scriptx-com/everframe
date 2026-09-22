// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Instrumented test for Modifier.txSensitive() — confirms the SemanticsNode for
// a `Box(Modifier.txSensitive())` carries TX_SENSITIVE_KEY=true. Requires
// :traceitx-core to depend on `androidx.compose.ui:ui-test-junit4` in
// `androidTestImplementation` (NOT `implementation` — Compose-isolation gate
// stays green on releaseRuntimeClasspath).
//
// This test runs only on a device/emulator (`./gradlew connectedAndroidTest`).
// In-sandbox CI without an emulator, this file is compile-checked via
// `:traceitx-core:assembleAndroidTest`. Plan 08 (release-APK gate) exercises
// the path against a phone emulator.
package com.traceitx.sensitive

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import org.junit.Assert
import org.junit.Rule
import org.junit.Test

class TxSensitiveModifierInstrumentedTest {

    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun box_with_txSensitive_modifier_exposes_TX_SENSITIVE_KEY() {
        composeRule.setContent {
            Box(modifier = Modifier.size(100.dp).txSensitive())
        }
        // Walk the root Semantics tree, find a node with TX_SENSITIVE_KEY=true.
        val rootNode = composeRule.onRoot().fetchSemanticsNode()
        Assert.assertTrue(
            "Expected at least one SemanticsNode with TX_SENSITIVE_KEY=true",
            findKey(rootNode),
        )
    }

    private fun findKey(node: androidx.compose.ui.semantics.SemanticsNode): Boolean {
        if (node.config.getOrElse(TX_SENSITIVE_KEY) { false }) return true
        return node.children.any { findKey(it) }
    }
}
