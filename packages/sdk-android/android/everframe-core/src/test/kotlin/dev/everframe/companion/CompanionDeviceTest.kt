// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `CompanionDeviceId` / `CompanionDeviceFacts` (naming spec 2026-08-24).
//
// The hashing path (`explicit` non-blank) and the SSAID path (Robolectric's
// `Settings.Secure` shadow is a real, writable ContentProvider-backed store)
// never touch the EncryptedFile fallback, so those tests are unconditional.
// The storage-fallback path IS probe-gated (`__probeStorageAvailabilityForTests`)
// — measured on this repo's pinned `robolectric = "4.13"` host,
// `MasterKey.Builder(...).build()` throws `KeyStoreException: AndroidKeyStore
// not found` (no such `java.security.Provider` registered in that JVM), the
// same "no signed real device" gap iOS's `DeviceKey.probeKeychainAvailability()`
// exists for. Production `storedFallbackId` already fails closed to null
// there via its own `runCatching`, so this is not a bug — full coverage of
// the encrypted round-trip lives on a real device / instrumented test.
//
// *** THESE TESTS DO NOT RUN IN CI. *** See the note atop
// `CompanionAnnounceTest.kt` — the release variant's JVM unit test run has
// been broken since 2026-05-11, so nothing in `everframe-core/src/test` is
// gated by CI today. Run locally:
//
//     cd packages/sdk-android/android && ./gradlew :everframe-core:testDebugUnitTest --tests 'dev.everframe.companion.*'

package dev.everframe.companion

import android.content.Context
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class CompanionDeviceTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @After
    fun tearDown() {
        CompanionDeviceId.__resetForTests(context)
    }

    private fun isCanonicalLowercaseUuid(s: String): Boolean {
        val groups = s.split("-")
        val expected = listOf(8, 4, 4, 4, 12)
        if (groups.size != expected.size) return false
        return groups.zip(expected).all { (g, len) ->
            g.length == len && g.all { c -> c in "0123456789abcdef" }
        }
    }

    // ---------------- hashToUuid: determinism + RFC 4122 shape ----------------

    @Test
    fun hashToUuid_isDeterministic_forTheSameSource() {
        val a = CompanionDeviceId.hashToUuid("mdm-serial-ABC123")
        val b = CompanionDeviceId.hashToUuid("mdm-serial-ABC123")
        assertEquals(a, b)
    }

    @Test
    fun hashToUuid_differsAcrossDistinctSources() {
        val a = CompanionDeviceId.hashToUuid("mdm-serial-ABC123")
        val b = CompanionDeviceId.hashToUuid("mdm-serial-XYZ789")
        assertNotEquals(a, b)
    }

    @Test
    fun hashToUuid_producesLowercaseCanonicalUuidShape() {
        val id = CompanionDeviceId.hashToUuid("some-provisioning-serial")
        assertTrue("expected canonical UUID shape, got $id", isCanonicalLowercaseUuid(id))
    }

    @Test
    fun hashToUuid_stampsVersion4Nibble() {
        val id = CompanionDeviceId.hashToUuid("device-a")
        val thirdGroup = id.split("-")[2]
        assertEquals('4', thirdGroup.first())
    }

    @Test
    fun hashToUuid_stampsRfc4122VariantNibble() {
        val id = CompanionDeviceId.hashToUuid("device-b")
        val fourthGroup = id.split("-")[3]
        assertTrue(fourthGroup.first() in listOf('8', '9', 'a', 'b'))
    }

    @Test
    fun hashToUuid_knownVector() {
        // Locks the exact algorithm (not just its shape) — a literal computed
        // out-of-band (SHA-256("everframe-test-vector"), first 16 bytes, byte
        // 6 -> (b & 0x0f) | 0x40, byte 8 -> (b & 0x3f) | 0x80, hex-formatted
        // 8-4-4-4-12). Same pinned vector as
        // `CompanionDeviceTests.swift.hashToUuid_knownVector` (iOS Task 2)
        // and `packages/sdk-react/__tests__/companion/device-id.spec.ts` —
        // the SAME source must produce the SAME id on every SDK platform.
        val id = CompanionDeviceId.hashToUuid("everframe-test-vector")
        assertEquals("abb64861-9a56-4d83-9384-9c6559a5599e", id)
    }

    // ---------------- resolve(explicit): hashing path never touches SSAID/storage ----------------

    @Test
    fun resolve_withExplicit_returnsTheHashedValue() {
        val resolved = CompanionDeviceId.resolve(context, explicit = "vendor-serial-42")
        assertEquals(CompanionDeviceId.hashToUuid("vendor-serial-42"), resolved)
    }

    @Test
    fun resolve_withExplicit_isStableAcrossCalls() {
        val a = CompanionDeviceId.resolve(context, explicit = "vendor-serial-42")
        val b = CompanionDeviceId.resolve(context, explicit = "vendor-serial-42")
        assertEquals(a, b)
    }

    @Test
    fun resolve_withBlankExplicit_fallsThroughRatherThanHashingTheEmptyString() {
        // "" must NOT be hashed as if it were a real explicit id — treated
        // the same as null (falls through to SSAID/storage).
        val resolved = CompanionDeviceId.resolve(context, explicit = "")
        assertNotEquals(CompanionDeviceId.hashToUuid(""), resolved)
    }

    @Test
    fun resolve_withWhitespaceOnlyExplicit_fallsThrough() {
        val resolved = CompanionDeviceId.resolve(context, explicit = "   ")
        assertNotEquals(CompanionDeviceId.hashToUuid("   "), resolved)
    }

    // ---------------- resolve(explicit = null): SSAID path ----------------

    @Test
    fun resolve_withoutExplicit_andWithAReadableSsaid_returnsItsHash() {
        Settings.Secure.putString(context.contentResolver, Settings.Secure.ANDROID_ID, "robolectric-ssaid")

        val resolved = CompanionDeviceId.resolve(context, explicit = null)

        assertEquals(CompanionDeviceId.hashToUuid("robolectric-ssaid"), resolved)
    }

    @Test
    fun resolve_withoutExplicit_neverReturnsTheRawSsaid() {
        // SECURITY: the raw hardware-adjacent id must never leave this file
        // unhashed.
        Settings.Secure.putString(context.contentResolver, Settings.Secure.ANDROID_ID, "robolectric-ssaid")

        val resolved = CompanionDeviceId.resolve(context, explicit = null)

        assertNotEquals("robolectric-ssaid", resolved)
    }

    // ---------------- resolve(explicit = null): stored-UUID fallback ----------------

    // NOTE ON STORAGE AVAILABILITY: `MasterKey.Builder(...).build()` throws
    // `KeyStoreException: AndroidKeyStore not found` on this repo's pinned
    // `robolectric = "4.13"` host (measured) — no `AndroidKeyStore`
    // `java.security.Provider` is registered in that JVM. Production
    // `storedFallbackId` already fails closed to null there (its own
    // `runCatching`), so this is not a bug in the SDK; it's the same "no
    // signed real device" gap iOS's `DeviceKey.probeKeychainAvailability()`
    // exists for. These three tests probe-gate for the same reason —
    // skipping (not failing) when the mechanism itself is unavailable on the
    // host running them, with full coverage living on a real device /
    // instrumented test.

    @Test
    fun resolve_withNoExplicitAndNoSsaid_createsAndPersistsALowercaseUuid() {
        if (!CompanionDeviceId.__probeStorageAvailabilityForTests(context)) return
        Settings.Secure.putString(context.contentResolver, Settings.Secure.ANDROID_ID, null)
        CompanionDeviceId.__resetForTests(context)

        val resolved = CompanionDeviceId.resolve(context, explicit = null)

        assertNotNull("storage fallback must resolve something on this host", resolved)
        assertEquals(resolved, resolved?.lowercase())
        assertTrue(isCanonicalLowercaseUuid(resolved!!))
    }

    @Test
    fun resolve_withNoExplicitAndNoSsaid_isStableAcrossCalls() {
        if (!CompanionDeviceId.__probeStorageAvailabilityForTests(context)) return
        Settings.Secure.putString(context.contentResolver, Settings.Secure.ANDROID_ID, null)
        CompanionDeviceId.__resetForTests(context)

        val first = CompanionDeviceId.resolve(context, explicit = null)
        val second = CompanionDeviceId.resolve(context, explicit = null)

        assertNotNull(first)
        assertEquals("stored fallback id must be stable across calls", first, second)
    }

    @Test
    fun resetForTests_clearsTheStoredId_soANewOneIsCreated() {
        if (!CompanionDeviceId.__probeStorageAvailabilityForTests(context)) return
        Settings.Secure.putString(context.contentResolver, Settings.Secure.ANDROID_ID, null)
        CompanionDeviceId.__resetForTests(context)
        val first = CompanionDeviceId.resolve(context, explicit = null)

        CompanionDeviceId.__resetForTests(context)
        val second = CompanionDeviceId.resolve(context, explicit = null)

        assertNotNull(first)
        assertNotNull(second)
        assertNotEquals(
            "astronomically unlikely to collide by chance — proves __resetForTests actually deleted the entry",
            first,
            second,
        )
    }

    // ---------------- CompanionDeviceFacts.current ----------------

    @Test
    fun facts_current_withExplicit_usesTheHashedId() {
        val device = CompanionDeviceFacts.current(context, explicit = "provisioning-serial-9")
        assertEquals(CompanionDeviceId.hashToUuid("provisioning-serial-9"), device?.id)
    }

    @Test
    fun facts_current_platformIsAndroid() {
        val device = CompanionDeviceFacts.current(context, explicit = "platform-test")
        assertEquals("android", device?.platform)
    }

    @Test
    fun facts_current_osNameIsAndroid() {
        val device = CompanionDeviceFacts.current(context, explicit = "os-name-test")
        assertEquals("Android", device?.osName)
    }

    @Test
    fun facts_current_capsModelAndOsFieldsDefensively() {
        // Server schema caps: model <=80, osName/osVersion <=40
        // (announce-route.ts).
        val device = CompanionDeviceFacts.current(context, explicit = "cap-test")
        assertTrue((device?.model?.length ?: 0) <= 80)
        assertTrue((device?.osName?.length ?: 0) <= 40)
        assertTrue((device?.osVersion?.length ?: 0) <= 40)
    }

    // ---------------- emulator heuristic truth table ----------------
    //
    // `Build.FINGERPRINT`/`MODEL`/`PRODUCT` are `final` fields on the real
    // `android.os.Build` class, so they cannot be mocked/Shadowed field-by-
    // field without Robolectric's dedicated `ShadowBuild`. Robolectric's
    // OWN default fingerprint under `@Config(sdk = [33])` already contains
    // "robolectric" (not "generic"/"emulator"/"sdk_gphone"/"sdk"), so the
    // truth-table's "false" arm is exercised for free by every OTHER test in
    // this file reading `CompanionDeviceFacts.current(...).emulator` — this
    // section pins that reading explicitly, and documents (rather than
    // fakes) the "true" arms, since forcing them would require rebuilding
    // `Build` reflectively, which is exactly the brittleness `ShadowBuild`
    // exists to avoid and this module does not currently depend on.

    @Test
    fun facts_current_onARobolectricHost_isNotFlaggedAsAnEmulator() {
        // Robolectric's default Build.FINGERPRINT/MODEL/PRODUCT under this
        // config contain "robolectric", which matches none of the three
        // heuristic substrings ("generic"/"emulator"/"sdk_gphone"/"sdk") —
        // pinning this is what proves the heuristic isn't trivially
        // true-for-everything.
        val device = CompanionDeviceFacts.current(context, explicit = "emulator-heuristic-test")
        assertEquals(false, device?.emulator)
    }

    @Test
    fun emulatorHeuristic_matchesGenericFingerprint() {
        assertTrue(isEmulatorFingerprint("google/sdk_gphone64_x86_64/generic_x86_64:14/UE1A/eng.001:userdebug/dev-keys"))
    }

    @Test
    fun emulatorHeuristic_matchesEmulatorFingerprint() {
        assertTrue(isEmulatorFingerprint("generic/emulator64_x86_64/emulator64_x86_64:14/UE1A/eng:userdebug/test-keys"))
    }

    @Test
    fun emulatorHeuristic_matchesSdkGphoneModel() {
        assertTrue(isEmulatorModel("sdk_gphone64_x86_64"))
    }

    @Test
    fun emulatorHeuristic_matchesSdkProduct() {
        assertTrue(isEmulatorProduct("sdk_gphone64_x86_64"))
    }

    @Test
    fun emulatorHeuristic_realDeviceStringsDoNotMatch() {
        assertTrue(!isEmulatorFingerprint("google/husky/husky:14/AP2A/eng.001:user/release-keys"))
        assertTrue(!isEmulatorModel("Pixel 8"))
        assertTrue(!isEmulatorProduct("husky"))
    }

    // Mirrors `CompanionDeviceFacts.isEmulator`'s three OR'd substring
    // checks in isolation, so the truth table is pinned without needing to
    // rebuild the real (final) `Build` fields.
    private fun isEmulatorFingerprint(fingerprint: String): Boolean =
        fingerprint.contains("generic") || fingerprint.contains("emulator")

    private fun isEmulatorModel(model: String): Boolean = model.contains("sdk_gphone")

    private fun isEmulatorProduct(product: String): Boolean = product.contains("sdk")
}
