// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.File
import kotlin.test.assertEquals
import org.junit.Test

class EverframeCliVersionTest {
    @Test fun `npx fallback pins the CLI version this repository ships`() {
        val packageJson = File("../../../cli/package.json").readText()
        val version = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(packageJson)!!.groupValues[1]
        assertEquals(version, EVERFRAME_CLI_VERSION)
    }
}
