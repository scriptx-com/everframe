// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// MAI meter Plan 2b-i. Two things under test, failing differently:
//
//   1. The DERIVATION, against the cross-SDK vector (test resource
//      install-id.v1.json, drift-guarded by fixture-sync.spec.ts). A break
//      here means this platform's installs are counted as a DIFFERENT
//      population than web's and iOS's.
//   2. The SEED STORE, whose contract is "any failure yields null, never a
//      partial or unstable value" — the caller feeds this into the config
//      URL, and that read is the SDK's remote kill switch.
//
// Plain SharedPreferences, not EncryptedFile: unlike CompanionDeviceTest's
// storage cases this needs no AndroidKeyStore probe-and-skip, so every case
// here runs for real on the Robolectric host.
//
// Run locally:
//   cd packages/sdk-android/android && \
//     ./gradlew :traceitx-core:testDebugUnitTest --tests 'com.traceitx.config.InstallIdentifier*'
package com.traceitx.config

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class InstallIdentifierTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test
    fun `derive matches every cross-SDK vector case`() {
        val text = javaClass.classLoader!!
            .getResourceAsStream("install-id.v1.json")!!
            .bufferedReader().use { it.readText() }
        val root = Json.parseToJsonElement(text).jsonObject
        assertEquals(
            root["domainSeparator"]!!.jsonPrimitive.content,
            InstallIdentifier.DOMAIN_SEPARATOR,
        )
        val cases = root["cases"]!!.jsonArray
        assertTrue(cases.isNotEmpty())
        for (element in cases) {
            val c = element.jsonObject
            assertEquals(
                "vector case: ${c["name"]!!.jsonPrimitive.content}",
                c["expected"]!!.jsonPrimitive.content,
                InstallIdentifier.derive(hexToBytes(c["seedHex"]!!.jsonPrimitive.content)),
            )
        }
    }

    @Test
    fun `derive emits only url-safe unpadded characters`() {
        val id = InstallIdentifier.derive(ByteArray(16) { 0xAB.toByte() })
        assertEquals(43, id.length)
        assertTrue(id.matches(Regex("^[A-Za-z0-9_-]+$")))
    }

    @Test
    fun `current is stable across calls`() {
        val first = InstallIdentifier.current(context)
        assertNotNull(first)
        assertEquals(first, InstallIdentifier.current(context))
    }

    @Test
    fun `the seed is persisted as 32 lowercase hex and never appears in the identifier`() {
        val id = InstallIdentifier.current(context)!!
        val stored = context
            .getSharedPreferences(InstallIdentifier.PREFS_NAME, Context.MODE_PRIVATE)
            .getString(InstallIdentifier.SEED_KEY, null)
        assertNotNull(stored)
        assertTrue(stored!!.matches(Regex("^[0-9a-f]{32}$")))
        // One-wayness is the whole point.
        assertFalse(id.contains(stored))
    }

    @Test
    fun `a malformed stored seed is discarded and re-minted, not used`() {
        val prefs = context.getSharedPreferences(InstallIdentifier.PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(InstallIdentifier.SEED_KEY, "not-hex-at-all").commit()
        assertNotNull(InstallIdentifier.current(context))
        val rewritten = prefs.getString(InstallIdentifier.SEED_KEY, null)
        assertNotNull(rewritten)
        assertTrue(rewritten!!.matches(Regex("^[0-9a-f]{32}$")))
    }

    @Test
    fun `an uppercase hex seed is treated as malformed so the shape check stays exact`() {
        // The shape check is web's /^[0-9a-f]{32}$/ exactly. A lenient reader
        // here would accept a value web rejects, and "same seed, same id"
        // would stop meaning anything.
        val prefs = context.getSharedPreferences(InstallIdentifier.PREFS_NAME, Context.MODE_PRIVATE)
        val upper = "A".repeat(32)
        prefs.edit().putString(InstallIdentifier.SEED_KEY, upper).commit()
        InstallIdentifier.current(context)
        assertNotEquals(upper, prefs.getString(InstallIdentifier.SEED_KEY, null))
    }

    @Test
    fun `two independent seeds derive different identifiers`() {
        assertNotEquals(
            InstallIdentifier.derive(hexToBytes("000102030405060708090a0b0c0d0e0f")),
            InstallIdentifier.derive(hexToBytes("0f0e0d0c0b0a09080706050403020100")),
        )
    }
}
