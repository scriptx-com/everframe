// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.capture

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Review Focus 2: an app with no versionName reports its versionCode, in release health and in every report. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class DeviceMetadataAppReleaseTest {
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private fun installed(versionName: String?, versionCode: Long) {
        shadowOf(context.packageManager).getInternalMutablePackageInfo(context.packageName).apply {
            this.versionName = versionName
            longVersionCode = versionCode
        }
    }
    @Test fun `a missing versionName reports the versionCode`() {
        installed(null, 42)
        val device = DeviceMetadata.collect(context)
        assertEquals("42", device["appVersion"])
        assertEquals(42L, device["appBuild"])
        assertEquals(AppRelease("42", "42"), DeviceMetadata.appRelease(context))
    }
    @Test fun `a versionName is the version and the versionCode the build`() {
        installed("2.4.0", 7)
        assertEquals("2.4.0", DeviceMetadata.collect(context)["appVersion"])
        assertEquals(AppRelease("2.4.0", "7"), DeviceMetadata.appRelease(context))
    }
}
