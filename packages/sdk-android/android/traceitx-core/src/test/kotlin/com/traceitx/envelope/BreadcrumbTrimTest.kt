// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// BreadcrumbTrim parity tests — drives every case in the shared fixture
// packages/protocol/__tests__/fixtures/breadcrumb-trim.v1.json (also
// consumed by sdk-core's TypeScript spec and sdk-ios's Swift mirror; all
// three must agree byte-for-byte), plus the ported 200-crumb count-cap test
// and an isTrimMarker discrimination test.
package com.traceitx.envelope

import com.traceitx.protocol.generated.Breadcrumb
import com.traceitx.protocol.generated.BreadcrumbKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class BreadcrumbTrimTest {

    @Serializable
    data class TrimFixture(
        val cases: List<TrimCase>,
    )

    @Serializable
    data class TrimCase(
        val name: String,
        val options: TrimCaseOptions,
        val input: List<Breadcrumb>,
        val expected: List<Breadcrumb>,
    )

    @Serializable
    data class TrimCaseOptions(
        val byteBudget: Int,
        val consoleEntryCap: Int,
    )

    private fun fixtureFile(): File {
        var dir = File(System.getProperty("user.dir")).absoluteFile
        while (dir.parentFile != null && !File(dir, "pnpm-workspace.yaml").exists()) {
            dir = dir.parentFile
        }
        return File(dir, "packages/protocol/__tests__/fixtures/breadcrumb-trim.v1.json")
    }

    private fun loadFixture(): TrimFixture {
        val json = Json { ignoreUnknownKeys = true }
        return json.decodeFromString(TrimFixture.serializer(), fixtureFile().readText())
    }

    @Test
    fun `parity fixture all cases`() {
        val fixture = loadFixture()
        for (c in fixture.cases) {
            val actual = BreadcrumbTrim.trim(
                c.input,
                byteBudget = c.options.byteBudget,
                consoleEntryCap = c.options.consoleEntryCap,
            )
            assertEquals("case=${c.name}", c.expected, actual)
        }
    }

    // --- 200-crumb count-cap port (mirrors breadcrumb-trim.spec.ts
    // "enforces the protocol 128-entry ceiling even when under the byte budget") ---

    @Test
    fun `enforces the protocol 128-entry ceiling even when under the byte budget`() {
        val taps = (0 until 200).map { i ->
            Breadcrumb(
                data = null,
                kind = BreadcrumbKind.Tap,
                level = null,
                message = "tap-btn-x",
                seq = i.toLong(),
                t = (i + 1).toDouble(),
                truncated = null,
            )
        }
        val out = BreadcrumbTrim.trim(taps, byteBudget = 10_000_000)
        assertTrue(out.size <= 128)

        val markers = out.filter { BreadcrumbTrim.isTrimMarker(it) }
        val kept = out.filter { !BreadcrumbTrim.isTrimMarker(it) }

        assertEquals(1, markers.size)
        assertEquals(BreadcrumbKind.Tap, markers[0].kind)
        assertEquals("+79 tap hidden", markers[0].message)
        assertEquals(79L, (markers[0].data?.get("droppedCount") as JsonPrimitive).content.toLong())

        // Kept entries are exactly the NEWEST 121 (t=80..200).
        assertEquals(BreadcrumbTrim.maxTrimmedEntries, kept.size)
        assertEquals(80.0, kept.first().t, 0.0)
        assertEquals(200.0, kept.last().t, 0.0)
        // Marker is stamped with the newest dropped entry (t=79) so it sorts first.
        assertEquals(79.0, markers[0].t, 0.0)
    }

    // --- Combined byte-eviction + count-cap (Task 3, ported from sdk-core's
    // "locks a combined byte-eviction + count-cap run identically across
    // TS/Swift/Kotlin" test — see fixture __semantics point 7). Numbers below
    // are hard-coded from the actual TS run; any divergence here would be a
    // real cross-SDK parity defect. ---

    @Test
    fun `combined byte-eviction and count-cap locks TS outcome numbers`() {
        val taps = (0 until 130).map { i ->
            Breadcrumb(
                data = null,
                kind = BreadcrumbKind.Tap,
                level = null,
                message = "tap-btn",
                seq = i.toLong(),
                t = (i + 1).toDouble(),
                truncated = null,
            )
        }
        val consoles = (0 until 5).map { i ->
            Breadcrumb(
                data = null,
                kind = BreadcrumbKind.Console,
                level = null,
                message = "c".repeat(1500),
                seq = (200 + i).toLong(),
                t = (200 + i).toDouble(),
                truncated = null,
            )
        }
        val input = taps + consoles

        val out = BreadcrumbTrim.trim(input, byteBudget = 12000, consoleEntryCap = 1024)
        val markers = out.filter { BreadcrumbTrim.isTrimMarker(it) }
        val kept = out.filter { !BreadcrumbTrim.isTrimMarker(it) }

        assertTrue(out.size <= BreadcrumbTrim.maxTrimmedEntries + markers.size)
        assertTrue(kept.size <= BreadcrumbTrim.maxTrimmedEntries)

        // Exactly one marker per kind that lost entries.
        assertEquals(2, markers.size)
        val consoleMarker = markers.first { it.kind == BreadcrumbKind.Console }
        val tapMarker = markers.first { it.kind == BreadcrumbKind.Tap }

        val consoleDropped = (consoleMarker.data?.get("droppedCount") as JsonPrimitive).content.toLong()
        val tapDropped = (tapMarker.data?.get("droppedCount") as JsonPrimitive).content.toLong()
        assertEquals(4L, consoleDropped)
        assertEquals(10L, tapDropped)

        // Conservation: every one of the 135 input entries is kept or
        // accounted for by exactly one marker's droppedCount.
        assertEquals(135L, consoleDropped + tapDropped + kept.size)

        // Recorded concrete outcome (hard-coded from the TS run).
        assertEquals(121, kept.size)
        assertEquals(203.0, consoleMarker.t, 0.0)
        assertEquals(203L, consoleMarker.seq)
        assertEquals(10.0, tapMarker.t, 0.0)
        assertEquals(9L, tapMarker.seq)

        // Must-keep: the newest tap (t=130) survives even though its kind lost entries.
        assertTrue(kept.any { it.kind == BreadcrumbKind.Tap && it.t == 130.0 })

        // NOTE (matches the TS test's NOTE): flipping byteBudget to a huge
        // value on THIS SAME 135-entry input does NOT make the console marker
        // vanish — the count-cap pass reuses the same bulky-before-structural
        // eviction order, and with only 4 non-must-keep consoles available,
        // all 4 get evicted by the count pass alone regardless of budget.
        // Verified below; the genuine byte-pass-fired sanity check (where
        // count-cap can never engage) is the sibling test right after this one.
        val outHugeBudget = BreadcrumbTrim.trim(input, byteBudget = 10_000_000, consoleEntryCap = 1024)
        val consoleMarkerHugeBudget = outHugeBudget
            .filter { BreadcrumbTrim.isTrimMarker(it) }
            .first { it.kind == BreadcrumbKind.Console }
        assertEquals(203.0, consoleMarkerHugeBudget.t, 0.0)
        assertEquals(203L, consoleMarkerHugeBudget.seq)
        assertEquals(
            4L,
            (consoleMarkerHugeBudget.data?.get("droppedCount") as JsonPrimitive).content.toLong(),
        )
    }

    @Test
    fun `byte-eviction pass sanity responds to byteBudget when count-cap cannot engage`() {
        // Only 6 total entries — far under maxTrimmedEntries (121), so the
        // count-cap pass can never fire regardless of byteBudget. This
        // isolates the byte-eviction pass: a tight budget forces console
        // eviction; a huge budget evicts nothing at all.
        val taps = (0 until 3).map { i ->
            Breadcrumb(
                data = null,
                kind = BreadcrumbKind.Tap,
                level = null,
                message = "tap-btn",
                seq = i.toLong(),
                t = (i + 1).toDouble(),
                truncated = null,
            )
        }
        val consoles = (0 until 3).map { i ->
            Breadcrumb(
                data = null,
                kind = BreadcrumbKind.Console,
                level = null,
                message = "c".repeat(1500),
                seq = (200 + i).toLong(),
                t = (200 + i).toDouble(),
                truncated = null,
            )
        }
        val input = taps + consoles

        val tight = BreadcrumbTrim.trim(input, byteBudget = 2000, consoleEntryCap = 1024)
        val tightMarkers = tight.filter { BreadcrumbTrim.isTrimMarker(it) }
        assertEquals(1, tightMarkers.size)
        assertEquals(BreadcrumbKind.Console, tightMarkers[0].kind)
        assertEquals(201.0, tightMarkers[0].t, 0.0)
        assertEquals(201L, tightMarkers[0].seq)
        assertEquals(
            2L,
            (tightMarkers[0].data?.get("droppedCount") as JsonPrimitive).content.toLong(),
        )

        val huge = BreadcrumbTrim.trim(input, byteBudget = 10_000_000, consoleEntryCap = 1024)
        assertEquals(0, huge.filter { BreadcrumbTrim.isTrimMarker(it) }.size)
        assertEquals(6, huge.size) // nothing evicted at all
    }

    // --- Surrogate-split characterization (accepted platform divergence) ---

    @Test
    fun `surrogate split keeps the lone high surrogate like JS slice`() {
        // 511 'a' + emoji (0xD83D 0xDE00) + 600 'b' = 1113 UTF-16 units, run
        // through the trim entry point with consoleEntryCap 1024 (huge
        // byteBudget so only the console cap fires). half = 512, so the head
        // keeps units [0..511]; unit 511 is the emoji's high surrogate and its
        // low-surrogate partner (unit 512) is dropped, splitting the pair.
        // Kotlin's String is UTF-16-backed natively (like JS), so substring
        // keeps the lone high surrogate verbatim — unlike Swift's
        // String(decoding:as:UTF16.self), which substitutes U+FFFD (see
        // breadcrumb-trim.spec.ts and BreadcrumbTrimTests.swift for the
        // counterparts).
        val message = "a".repeat(511) + "😀" + "b".repeat(600)
        val crumb = Breadcrumb(
            data = null,
            kind = BreadcrumbKind.Console,
            level = null,
            message = message,
            seq = 0,
            t = 1.0,
            truncated = null,
        )
        val out = BreadcrumbTrim.trim(listOf(crumb), byteBudget = 10_000_000, consoleEntryCap = 1024)
        assertEquals(true, out.first().truncated)
        assertEquals(0xD83D, out.first().message[511].code)
    }

    // --- isTrimMarker ---

    @Test
    fun `isTrimMarker discriminates on numeric data droppedCount`() {
        val numeric = Breadcrumb(
            data = buildJsonObject { put("droppedCount", JsonPrimitive(3)) },
            kind = BreadcrumbKind.Console,
            level = null,
            message = "m",
            seq = 0,
            t = 1.0,
            truncated = null,
        )
        val stringy = Breadcrumb(
            data = buildJsonObject { put("droppedCount", JsonPrimitive("x")) },
            kind = BreadcrumbKind.Console,
            level = null,
            message = "m",
            seq = 0,
            t = 1.0,
            truncated = null,
        )
        val absent = Breadcrumb(
            data = null,
            kind = BreadcrumbKind.Console,
            level = null,
            message = "m",
            seq = 0,
            t = 1.0,
            truncated = null,
        )
        assertTrue(BreadcrumbTrim.isTrimMarker(numeric))
        assertFalse(BreadcrumbTrim.isTrimMarker(stringy))
        assertFalse(BreadcrumbTrim.isTrimMarker(absent))
    }
}
