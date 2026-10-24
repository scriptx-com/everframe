// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device link token storage. Tests assert presence and shape of tokens; they
// never print token values.

package dev.everframe.devicelink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.KeyStoreException

class DeviceLinkStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var file: File
    private lateinit var keys: JceTestDeviceLinkKeyProvider
    private val scope = "scope-a"
    private val token = "evf_dev_" + "a1B2".repeat(8)

    @Before
    fun setUp() {
        file = File(tmp.newFolder("dev.everframe"), "device-link-v1.bin")
        keys = JceTestDeviceLinkKeyProvider()
    }

    private fun store() = DeviceLinkStore(file, keys)

    private fun link(owner: DeviceLinkOwner = DeviceLinkOwner.User("Aurimas Secretname"), t: String = token) =
        StoredDeviceLink(t, owner, scope)

    @Test
    fun tokenFormat() {
        assertTrue(DeviceLinkToken.isValid("evf_dev_" + "a1B2".repeat(8)))
        listOf(
            null, "", "evf_dev_short", "evf_cap_" + "a".repeat(32), "evf_dev_" + "a".repeat(31) + "-",
            " evf_dev_" + "a".repeat(32), "evf_dev_" + "a".repeat(33),
        ).forEachIndexed { i, raw -> assertFalse("case $i", DeviceLinkToken.isValid(raw)) }
    }

    @Test
    fun savedLinkSurvivesANewStoreInstance() {
        assertTrue(store().save(link()))
        val loaded = DeviceLinkStore(file, keys).load(scope)
        assertNotNull(loaded)
        assertTrue(loaded!!.token == token)
        assertEquals(DeviceLinkOwner.User("Aurimas Secretname"), loaded.owner)
        assertEquals(scope, loaded.scope)

        assertTrue(store().save(link(owner = DeviceLinkOwner.Team)))
        assertEquals(DeviceLinkOwner.Team, DeviceLinkStore(file, keys).load(scope)!!.owner)
    }

    @Test
    fun fileNeverContainsThePlainToken() {
        assertTrue(store().save(link()))
        val bytes = String(file.readBytes(), Charsets.ISO_8859_1)
        assertFalse(bytes.contains(token))
        assertFalse(bytes.contains("Secretname"))
        assertTrue(bytes.startsWith("EFDL"))
    }

    @Test
    fun loadWithAnotherScopeIsNullAndKeepsTheFile() {
        assertTrue(store().save(link()))
        assertNull(store().load("other"))
        assertTrue(file.exists())
        assertNotNull(store().load(scope))
    }

    @Test
    fun clearDeletesFileAndKey() {
        assertTrue(store().save(link()))
        store().clear()
        assertNull(store().load(scope))
        assertFalse(file.exists())
        assertEquals(1, keys.deletes)
    }

    @Test
    fun undecryptableFileIsDeletedAndReadsNull() {
        file.writeBytes(byteArrayOf(1, 2, 3, 4, 5))
        assertNull(store().load(scope))
        assertFalse(file.exists())

        // Encrypted under a key that no longer exists (keystore wiped, file copied to a new device).
        assertTrue(store().save(link()))
        keys.key = null
        assertNull(store().load(scope))
        assertFalse(file.exists())
    }

    @Test
    fun keyProviderThrowingReadsNullAndSaveReturnsFalse() {
        assertTrue(store().save(link()))
        keys.failWith = KeyStoreException("keystore unavailable")
        assertNull(store().load(scope))
        assertFalse(store().save(link()))
        store().clear()
    }

    @Test
    fun saveRefusesAnInvalidToken() {
        assertFalse(store().save(StoredDeviceLink("evf_dev_x", DeviceLinkOwner.Team, scope)))
        assertFalse(file.exists())
    }

    @Test
    fun toStringRedactsTheToken() {
        val l = link()
        assertFalse(l.toString().contains(l.token))
        assertTrue(l.toString().contains("token=<redacted>"))
    }

    @Test
    fun displayNameIsBoundedAndNeverBlank() {
        assertEquals("teammate", DeviceLinkOwner.User("  ").displayName())
        assertEquals("Ann Lee", DeviceLinkOwner.User(" Ann\nLee ").displayName().replace("  ", " "))
        assertEquals(41, DeviceLinkOwner.User("x".repeat(80)).displayName().length) // 40 + "…"
        assertTrue(DeviceLinkOwner.User("x".repeat(80)).displayName().endsWith("…"))
        assertEquals("teammate", DeviceLinkOwner.User("\u0000\u001b").displayName())
    }

    @Test
    fun scopeDependsOnOriginAndKey() {
        val a = DeviceLinkScope.of("https://a.dev", "k")
        assertNotNull(a)
        assertEquals(a, DeviceLinkScope.of("https://A.dev:443/api/ingest", "k"))
        assertNotEquals(a, DeviceLinkScope.of("https://b.dev", "k"))
        assertNotEquals(a, DeviceLinkScope.of("https://a.dev", "k2"))
        assertNotEquals(a, DeviceLinkScope.of("http://a.dev", "k"))
        assertNull(DeviceLinkScope.of("not a url", "k"))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(a!!))
    }

    @Test
    fun nonceShape() {
        val shape = Regex("^[0-9A-Za-z]{40}$")
        val nonces = (1..1000).map { LinkNonce.generate() }
        assertTrue(nonces.all { shape.matches(it) })
        assertEquals(1000, nonces.toSet().size)
    }
}
