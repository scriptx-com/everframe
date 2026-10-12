// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import java.io.File
import java.util.Properties
import org.gradle.api.Project
import org.gradle.api.provider.Provider

/** packages/cli/package.json "version", compiled into the plugin (EverframeCliVersionTest). */
internal val EVERFRAME_CLI_VERSION: String by lazy {
    val properties = Properties()
    EverframePlugin::class.java.getResourceAsStream("/dev/everframe/gradle/cli-version.properties")?.use(properties::load)
    properties.getProperty("version") ?: error("everframe-gradle-plugin: cli-version.properties missing from the plugin JAR")
}

/** `EVERFRAME_CLI_JS`, then the project's node_modules, then `npx` pinned to [EVERFRAME_CLI_VERSION]. */
internal fun defaultCliCommand(project: Project): Provider<List<String>> {
    val rootDir = project.rootDir
    return project.providers.environmentVariable("EVERFRAME_CLI_JS").map { listOf("node", it) }
        .orElse(project.providers.provider {
            listOf(File(rootDir, "../node_modules/@everframe/cli/dist/index.js"), File(rootDir, "node_modules/@everframe/cli/dist/index.js"))
                .firstOrNull(File::isFile)
                ?.let { listOf("node", it.canonicalPath) }
                ?: listOf("npx", "--yes", "--prefer-offline", "@everframe/cli@$EVERFRAME_CLI_VERSION")
        })
}
