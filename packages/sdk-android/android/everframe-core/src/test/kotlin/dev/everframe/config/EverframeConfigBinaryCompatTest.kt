// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Callers compiled against earlier releases bind to JVM descriptors, so adding `debugBuild` and then
 * `reporterEnabled` must not remove or change any constructor or `copy` they were compiled against. A removed
 * descriptor fails at run time with NoSuchMethodError, which no source-level test would show.
 */
class EverframeConfigBinaryCompatTest {
    private val firstFifteen: List<Class<*>> = listOf(
        String::class.java, String::class.java, Environment::class.java, String::class.java,
        CaptureConfig::class.java, Boolean::class.javaPrimitiveType!!, Boolean::class.javaPrimitiveType!!,
        String::class.java, Boolean::class.javaPrimitiveType!!, Boolean::class.javaPrimitiveType!!,
        String::class.java, ReporterThemeOptions::class.java, Boolean::class.javaPrimitiveType!!,
        VitalsConfig::class.java, String::class.java,
    )
    private val releaseHealth = ReleaseHealthConfig::class.java
    private val boxedBoolean = java.lang.Boolean::class.java
    private val marker = Class.forName("kotlin.jvm.internal.DefaultConstructorMarker")
    private val int = Int::class.javaPrimitiveType!!

    private fun ctor(vararg extra: Class<*>) =
        EverframeConfig::class.java.getDeclaredConstructor(*(firstFifteen + extra).toTypedArray())

    private fun copy(vararg extra: Class<*>) =
        EverframeConfig::class.java.getDeclaredMethod("copy", *(firstFifteen + extra).toTypedArray())

    private fun copyDefault(vararg extra: Class<*>) = EverframeConfig::class.java.getDeclaredMethod(
        "copy\$default", *(listOf<Class<*>>(EverframeConfig::class.java) + firstFifteen + extra + listOf(int, Any::class.java)).toTypedArray())

    private fun args(vararg extra: Any?): Array<Any?> = (listOf<Any?>(
        "app", "txx_live_test1234567890", Environment.staging, "1.2.3", CaptureConfig(), false, true,
        "device", false, false, "top", null, false, VitalsConfig(), "mapping",
    ) + extra.toList()).toTypedArray()

    /** Arguments for a synthetic default-argument constructor: the first two parameters given, the rest defaulted. */
    private fun defaultedArgs(types: List<Class<*>>): Array<Any?> {
        val placeholders = types.drop(2).map { if (it == Boolean::class.javaPrimitiveType) false else null }
        val mask = ((1 shl types.size) - 1) and 0b11.inv()
        return (listOf<Any?>("app", "key") + placeholders + listOf(mask, null)).toTypedArray()
    }

    @Test fun `the 15-argument constructor and its default-argument variant still exist`() {
        val explicit = ctor().newInstance(*args()) as EverframeConfig
        assertEquals("app", explicit.appId)
        assertEquals(Environment.staging, explicit.environment)
        assertEquals(ReleaseHealthConfig(), explicit.releaseHealth)
        assertNull(explicit.debugBuild)

        // What a Kotlin caller compiled against the earlier release emits for EverframeConfig("app", "key").
        val defaulted = EverframeConfig::class.java.getDeclaredConstructor(
            *(firstFifteen + listOf(int, marker)).toTypedArray())
        val viaDefaults = defaulted.newInstance(*defaultedArgs(firstFifteen))
        assertEquals("app", (viaDefaults as EverframeConfig).appId)
        assertEquals(Environment.production, viaDefaults.environment)
        assertEquals(ReleaseHealthConfig(), viaDefaults.releaseHealth)
        assertNull(viaDefaults.debugBuild)
    }

    @Test fun `the 16-argument constructor with releaseHealth and its default-argument variant still exist`() {
        val explicit = ctor(releaseHealth).newInstance(*args(null)) as EverframeConfig
        assertNull(explicit.releaseHealth)
        assertNull(explicit.debugBuild)

        val disabled = ReleaseHealthConfig(enabled = false)
        val kept = ctor(releaseHealth).newInstance(*args(disabled)) as EverframeConfig
        assertEquals(disabled, kept.releaseHealth)

        val defaulted = EverframeConfig::class.java.getDeclaredConstructor(
            *(firstFifteen + listOf(releaseHealth, int, marker)).toTypedArray())
        assertNotNull(defaulted)
        val viaDefaults = defaulted.newInstance(*defaultedArgs(firstFifteen + releaseHealth)) as EverframeConfig
        assertEquals(ReleaseHealthConfig(), viaDefaults.releaseHealth)
        assertNull(viaDefaults.debugBuild)
    }

    @Test fun `the earlier copy overloads still exist and keep releaseHealth and debugBuild`() {
        val source = EverframeConfig(
            appId = "app", sdkKey = "txx_live_test1234567890", releaseHealth = null, debugBuild = true)

        val copy15 = copy().invoke(source, *args()) as EverframeConfig
        assertEquals("1.2.3", copy15.release)
        assertNull(copy15.releaseHealth)
        assertEquals(true, copy15.debugBuild)

        val copy16 = copy(releaseHealth).invoke(source, *args(ReleaseHealthConfig(enabled = false))) as EverframeConfig
        assertEquals(false, copy16.releaseHealth!!.enabled)
        assertEquals(true, copy16.debugBuild)

        // The synthetic default-argument variants an old compiled `config.copy(sdkKey = ...)` calls.
        assertNotNull(copyDefault())
        assertNotNull(copyDefault(releaseHealth))
    }

    @Test fun `the 17-argument constructor with debugBuild and its default-argument variant still exist`() {
        val explicit = ctor(releaseHealth, boxedBoolean).newInstance(*args(null, true)) as EverframeConfig
        assertNull(explicit.releaseHealth)
        assertEquals(true, explicit.debugBuild)
        assertTrue("an earlier caller never turned the reporter off", explicit.reporterEnabled)

        val defaulted = EverframeConfig::class.java.getDeclaredConstructor(
            *(firstFifteen + listOf(releaseHealth, boxedBoolean, int, marker)).toTypedArray())
        val viaDefaults = defaulted.newInstance(*defaultedArgs(firstFifteen + releaseHealth + boxedBoolean)) as EverframeConfig
        assertEquals(ReleaseHealthConfig(), viaDefaults.releaseHealth)
        assertNull(viaDefaults.debugBuild)
        assertTrue(viaDefaults.reporterEnabled)
    }

    @Test fun `the earlier copy overloads keep reporterEnabled`() {
        val source = EverframeConfig(appId = "app", sdkKey = "txx_live_test1234567890", reporterEnabled = false)

        assertFalse((copy().invoke(source, *args()) as EverframeConfig).reporterEnabled)
        assertFalse((copy(releaseHealth).invoke(source, *args(null)) as EverframeConfig).reporterEnabled)
        val copy17 = copy(releaseHealth, boxedBoolean).invoke(source, *args(null, true)) as EverframeConfig
        assertEquals(true, copy17.debugBuild)
        assertFalse(copy17.reporterEnabled)
        assertNotNull(copyDefault(releaseHealth, boxedBoolean))

        // Source callers that name only older parameters resolve to these overloads too.
        assertFalse(source.copy(sdkKey = "other").reporterEnabled)
        assertFalse(source.copy(releaseHealth = null).reporterEnabled)
        assertFalse(source.copy(debugBuild = true).reporterEnabled)
        assertFalse(source.copy(r8MappingId = "mapping").reporterEnabled)
    }

    @Test fun `the new constructor and copy take debugBuild and reporterEnabled alongside`() {
        val config = EverframeConfig(appId = "app", sdkKey = "key", debugBuild = false)
        assertEquals(false, config.debugBuild)
        assertTrue("the reporter is on unless a host turns it off", config.reporterEnabled)
        assertEquals(true, config.copy(debugBuild = true).debugBuild)
        assertEquals(false, config.copy(sdkKey = "other").debugBuild)
        assertEquals(false, config.copy(releaseHealth = null).debugBuild)
        assertFalse(config.copy(reporterEnabled = false).reporterEnabled)
        assertEquals(false, config.copy(reporterEnabled = false).debugBuild)
        val primary = EverframeConfig::class.java.getDeclaredConstructor(
            *(firstFifteen + listOf(releaseHealth, boxedBoolean, Boolean::class.javaPrimitiveType!!)).toTypedArray())
        assertNotNull(primary)
        assertNotNull(copy(releaseHealth, boxedBoolean, Boolean::class.javaPrimitiveType!!))
    }
}
