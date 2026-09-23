// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.gradle

import java.io.File
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AndroidPublicationContractTest {
    private val androidRoot = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .flatMap { directory -> sequenceOf(directory, directory.resolve("packages/sdk-android/android")) }
        .first { it.resolve("settings.gradle.kts").isFile && it.resolve("everframe-core").isDirectory }

    @Test
    fun `canonical modules and publication coordinates use Everframe identity`() {
        val settings = androidRoot.resolve("settings.gradle.kts").readText()
        val rootBuild = androidRoot.resolve("build.gradle.kts").readText()

        listOf("protocol", "core", "reporter-ui", "media3", "gradle-plugin").forEach { artifact ->
            assertTrue(androidRoot.resolve("everframe-$artifact").isDirectory, "missing everframe-$artifact module")
            assertTrue(settings.contains("include(\":everframe-$artifact\")"), "settings must include :everframe-$artifact")
        }
        assertTrue(rootBuild.contains("group = \"dev.everframe\""))
        assertTrue(rootBuild.contains("everframeVersion"))
        assertTrue(rootBuild.contains("everframeDevLocal"))
        assertFalse(settings.contains("trace" + "itx", ignoreCase = true))
    }

    @Test
    fun `build and publication configuration cannot target staging compatibility APIs`() {
        val publishingFiles = androidRoot.walkTopDown()
            .filter { it.isFile && (it.extension in setOf("kts", "properties") || it.name.endsWith(".gradle")) }
            .toList()
        val forbidden = Regex("ossrh|staging/deploy|ossrh-staging-api|service/local/staging", RegexOption.IGNORE_CASE)

        publishingFiles.forEach { file ->
            assertFalse(forbidden.containsMatchIn(file.readText()), "${file.relativeTo(androidRoot)} references a staging compatibility API")
        }
    }
}
