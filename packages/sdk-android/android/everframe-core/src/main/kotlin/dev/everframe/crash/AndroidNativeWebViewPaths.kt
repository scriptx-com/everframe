// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.pm.ApplicationInfo
import android.webkit.WebView
import java.io.File
import java.io.IOException

/**
 * Code locations of the current WebView provider. WebView installs an in-process crash
 * handler when it initializes; that handler restores the one it replaced and re-raises, so
 * native signal capture admits a handler inside these paths as a chaining collector.
 */
@androidx.annotation.RequiresApi(26)
internal object AndroidNativeWebViewPaths {
    private const val MAX_PATHS = 32

    /** Queries the WebView update service; never loads WebView into this process. */
    fun current(): Array<String> = try { of(WebView.getCurrentWebViewPackage()?.applicationInfo) } catch (_: Exception) { emptyArray() }

    /** Provider APK, splits, static shared library APKs (such as Trichrome) and library
     * directory, each also in canonical form because the linker reports real paths. */
    fun of(info: ApplicationInfo?): Array<String> {
        if (info == null) return emptyArray()
        val paths = listOfNotNull(info.sourceDir, info.nativeLibraryDir) + info.splitSourceDirs.orEmpty() +
            info.sharedLibraryFiles.orEmpty().filter { it.endsWith(".apk") }
        return paths.filter { it.startsWith("/") }.flatMap { listOf(it, try { File(it).canonicalPath } catch (_: IOException) { it }) }
            .distinct().take(MAX_PATHS).toTypedArray()
    }
}
