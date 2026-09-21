// ShotListOpsTest.kt — plain JUnit, NO Robolectric/Compose (pure decision logic).
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Android Task 7 — ported 1:1 from packages/sdk-ios/Tests/TraceItXReporterUITests/
// AnnotationModelTests.swift's ShotListOpsTests (4 cases).
package com.traceitx.ui.annotation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShotListOpsTest {
    @Test fun confirmOnlyWhenAnnotated() {
        assertFalse(ShotListOps.deleteNeedsConfirmation(annotationCount = 0))
        assertTrue(ShotListOps.deleteNeedsConfirmation(annotationCount = 3))
    }

    @Test fun deleteSelectsNeighbor() {
        // 3 shots, delete middle (1) → active stays 1 (the old index now points at the next shot)
        assertEquals(
            ShotListOps.DeleteOutcome(newActiveIndex = 1),
            ShotListOps.delete(at = 1, count = 3),
        )
        // delete last (2) of 3 → active clamps to 1
        assertEquals(1, ShotListOps.delete(at = 2, count = 3).newActiveIndex)
        // delete the only shot → empty list allowed
        assertEquals(
            ShotListOps.DeleteOutcome(newActiveIndex = null),
            ShotListOps.delete(at = 0, count = 1),
        )
    }

    @Test fun addTileHiddenAtCap() {
        assertTrue(ShotListOps.showsAddTile(count = 4))
        assertFalse(ShotListOps.showsAddTile(count = 5))
        assertTrue(ShotListOps.showsAddTile(count = 0))
    }
}
