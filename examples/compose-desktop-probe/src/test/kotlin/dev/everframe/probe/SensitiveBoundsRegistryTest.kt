// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.probe

import java.awt.Rectangle
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class SensitiveBoundsRegistryTest {
    @Test
    fun followsMeasuredMovementAndRoundsOutward() {
        val registry = SensitiveBoundsRegistry()
        assertNull(registry.snapshot())
        registry.update(40.2f, 140.3f, 160.1f, 80.2f)
        assertEquals(Rectangle(40, 140, 161, 81), registry.snapshot())
        registry.update(40f, 340f, 160f, 80f)
        assertEquals(Rectangle(40, 340, 160, 80), registry.snapshot())
        registry.clear()
        assertNull(registry.snapshot())
    }

    @Test
    fun invalidGeometryCannotReuseAnEarlierMask() {
        val registry = SensitiveBoundsRegistry()
        registry.update(40f, 140f, 160f, 80f)
        registry.update(Float.NaN, 140f, 160f, 80f)
        assertNull(registry.snapshot())
        registry.update(40f, 140f, 0f, 80f)
        assertNull(registry.snapshot())
    }
}
