// TextCommitLogicTest.kt — plain JUnit, NO Robolectric/Compose (pure decision logic).
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Android Task 6 — ported 1:1 from packages/sdk-ios/Tests/EverframeReporterUITests/
// AnnotationModelTests.swift's TextCommitLogicTests (6 cases).
package dev.everframe.ui.annotation

import org.junit.Assert.assertEquals
import org.junit.Test

class TextCommitLogicTest {
    @Test fun newNonEmptyAppends() {
        assertEquals(TextCommitAction.AppendNew, textCommitAction(existingId = null, trimmedText = "hello"))
    }

    @Test fun newEmptyCancelsSilently() {
        assertEquals(TextCommitAction.Cancel, textCommitAction(existingId = null, trimmedText = ""))
    }

    @Test fun newWhitespaceOnlyIsEmpty() {
        assertEquals(TextCommitAction.Cancel, textCommitAction(existingId = null, trimmedText = "   \n  \t "))
    }

    @Test fun existingNonEmptyPatches() {
        assertEquals(TextCommitAction.Patch("a1"), textCommitAction(existingId = "a1", trimmedText = "hello"))
    }

    @Test fun existingEmptyDeletes() {
        assertEquals(TextCommitAction.Delete("a1"), textCommitAction(existingId = "a1", trimmedText = ""))
    }

    @Test fun existingWhitespaceOnlyDeletes() {
        assertEquals(TextCommitAction.Delete("a1"), textCommitAction(existingId = "a1", trimmedText = "   \n\n  "))
    }
}
