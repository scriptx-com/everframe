// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure, network-free tests for the Task 9 wire-naming helpers extracted
// into EnvelopeBuilder.kt — `partName(kind:index:)` and
// `buildAttachmentPlan(annotatedFlags:)`. Mirrors iOS's
// ReporterSubmissionMultiShotTests.swift (Task 10 parity).
package com.traceitx.envelope

import com.traceitx.protocol.generated.AttachmentKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EnvelopePartNamingTest {
    @Test fun shotOneKeepsBareNames() {
        assertEquals("screenshot", partName("screenshot", 0))
        assertEquals("annotated-screenshot", partName("annotated-screenshot", 0))
    }

    @Test fun laterShotsSuffixedOneBased() {
        assertEquals("screenshot-2", partName("screenshot", 1))
        assertEquals("annotated-screenshot-5", partName("annotated-screenshot", 4))
    }

    @Test fun kindFollowsAnnotatedFlagPerShot() {
        val plan = buildAttachmentPlan(annotatedFlags = listOf(true, false, true))
        assertEquals(
            listOf("annotated-screenshot", "screenshot-2", "annotated-screenshot-3"),
            plan.map { it.partName },
        )
        assertEquals(
            listOf(AttachmentKind.AnnotatedScreenshot, AttachmentKind.Screenshot, AttachmentKind.AnnotatedScreenshot),
            plan.map { it.kind },
        )
    }

    @Test fun emptyFlagsProduceEmptyPlan() {
        assertTrue(buildAttachmentPlan(annotatedFlags = emptyList()).isEmpty())
    }
}
