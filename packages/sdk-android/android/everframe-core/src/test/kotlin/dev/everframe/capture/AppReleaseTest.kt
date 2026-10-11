// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import org.junit.Assert.assertEquals
import org.junit.Test

/** The one version rule shared by release health and every report's context.app.version. */
class AppReleaseTest {
    @Test fun `the trimmed versionName is the version and the versionCode the build`() {
        assertEquals(AppRelease("2.4.0", "42"), AppReleaseRule.of("2.4.0", 42))
        assertEquals(AppRelease("2.4.0", "7"), AppReleaseRule.of("  2.4.0 ", 7))
    }
    @Test fun `a missing or invalid versionName reports the versionCode`() {
        assertEquals(AppRelease("42", "42"), AppReleaseRule.of(null, 42))
        assertEquals(AppRelease("7", "7"), AppReleaseRule.of("", 7))
        assertEquals(AppRelease("7", "7"), AppReleaseRule.of("a".repeat(65), 7))
        assertEquals(AppRelease("7", "7"), AppReleaseRule.of("bad\u0000", 7))
        assertEquals(AppRelease("7", "7"), AppReleaseRule.of("\ud800", 7))
    }
    @Test fun `unreadable package info is version 0-dot-0-dot-0 with no build`() {
        assertEquals(AppRelease("0.0.0", null), AppReleaseRule.of(null, null))
        assertEquals("0.0.0", AppReleaseRule.UNKNOWN_VERSION)
    }
    @Test fun `64 UTF-16 units is the longest versionName`() {
        assertEquals(64, AppReleaseRule.MAX_LENGTH)
        assertEquals("a".repeat(64), AppReleaseRule.of("a".repeat(64), 7).version)
        // 32 emoji are 64 UTF-16 units; 33 are 66.
        assertEquals("😀".repeat(32), AppReleaseRule.of("😀".repeat(32), 7).version)
        assertEquals("7", AppReleaseRule.of("😀".repeat(33), 7).version)
    }
    @Test fun `version strings that are not URL safe are kept as they are`() {
        for (name in listOf("2.4.0+42", "1.0 (beta)/rc", "2.0-β")) assertEquals(name, AppReleaseRule.of(name, 7).version)
    }
}
