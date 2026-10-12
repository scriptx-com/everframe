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

/**
 * `EVERFRAME_CLI_JS`, then `@everframe/cli` in node_modules, then `npx` pinned to [EVERFRAME_CLI_VERSION].
 * node_modules is searched as Node resolves a package from the app's root (the folder holding
 * `android`): there, then each parent folder, so hoisted monorepo installs are found too.
 * The CLI runs with `NODE_BINARY` when it is set, as React Native's build scripts do, else `node`.
 * Both variables are read through providers, so the configuration cache tracks them.
 */
internal fun defaultCliCommand(project: Project): Provider<List<String>> {
    val rootDir = project.rootDir
    val node = nodeBinary(project)
    return project.providers.environmentVariable("EVERFRAME_CLI_JS").zip(node) { cli, binary -> listOf(binary, cli) }
        .orElse(project.providers.provider {
            installedCli(rootDir)?.let { listOf(node.get(), it.canonicalPath) }
                ?: listOf("npx", "--yes", "--prefer-offline", "@everframe/cli@$EVERFRAME_CLI_VERSION")
        })
}

/** `NODE_BINARY` unless it is unset or empty, else `node` from PATH. */
internal fun nodeBinary(project: Project): Provider<String> =
    project.providers.environmentVariable("NODE_BINARY").map { value -> value.trim() }
        .orElse("")
        .map { value -> value.ifEmpty { "node" } }

/** The installed CLI entry point for a Gradle root folder, or null. */
internal fun installedCli(rootDir: File): File? {
    val appRoot = rootDir.absoluteFile.parentFile ?: return null
    val folders = sequenceOf(appRoot, rootDir.absoluteFile) + generateSequence(appRoot.parentFile) { it.parentFile }
    return folders.map { File(it, "node_modules/@everframe/cli/dist/index.js") }.firstOrNull(File::isFile)
}
