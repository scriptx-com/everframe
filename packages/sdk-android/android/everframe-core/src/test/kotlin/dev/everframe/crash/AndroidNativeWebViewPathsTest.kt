// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.pm.ApplicationInfo
import org.junit.Assert.*
import org.junit.Test

class AndroidNativeWebViewPathsTest {
    @Test fun `provider APKs splits static library APKs and library directory are compatible code paths`() {
        val info = ApplicationInfo().apply {
            sourceDir = "/data/app/~~a/com.google.android.webview-b/base.apk"
            splitSourceDirs = arrayOf("/data/app/~~a/com.google.android.webview-b/split_config.arm64_v8a.apk")
            nativeLibraryDir = "/data/app/~~a/com.google.android.webview-b/lib/arm64"
            sharedLibraryFiles = arrayOf("/data/app/~~c/com.google.android.trichromelibrary_1-d/base.apk", "/system/framework/org.apache.http.legacy.jar")
        }
        assertEquals(listOf("/data/app/~~a/com.google.android.webview-b/base.apk", "/data/app/~~a/com.google.android.webview-b/lib/arm64",
            "/data/app/~~a/com.google.android.webview-b/split_config.arm64_v8a.apk", "/data/app/~~c/com.google.android.trichromelibrary_1-d/base.apk"),
            AndroidNativeWebViewPaths.of(info).toList())
    }
    @Test fun `no provider admits no collector`() {
        assertEquals(0, AndroidNativeWebViewPaths.of(null).size)
        assertEquals(0, AndroidNativeWebViewPaths.of(ApplicationInfo().apply { sourceDir = "relative/base.apk" }).size)
    }
}
