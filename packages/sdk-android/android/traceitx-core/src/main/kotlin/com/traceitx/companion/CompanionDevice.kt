// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Stable companion device identity (naming spec 2026-08-24 §1). Port of
// `packages/sdk-react/src/companion/device-id.ts` (+ `device-facts.ts`) and
// `packages/sdk-ios/Sources/TraceItX/Companion/CompanionDevice.swift` to the
// Android world — same resolution order, same hashing contract.
//
// Resolution chain, most-stable-first:
//   1. Explicit host config (MDM id, provisioning serial) — the host knows
//      best, and is honored on EVERY call (unlike the storage-fallback path,
//      there is no "first call wins" memo here; `RelayWSClient` awaits its
//      `deviceProvider` fresh on each announce, and `CompanionDeviceFacts`
//      itself does no caching — cheap enough to recompute).
//   2. `Settings.Secure.ANDROID_ID` (SSAID) — device-and-app-signing-key
//      scoped, survives reinstall under the same signing key, HASHED before
//      it ever leaves this file (it is a real hardware-adjacent identifier).
//   3. A random UUID, generated on first use and persisted per-install —
//      the Android analogue of the web module's localStorage UUID / iOS's
//      Keychain-stored UUID. Reuses `outbox/DeviceKey.kt`'s
//      EncryptedFile-backed storage mechanism (AES256-GCM master key +
//      AES256_GCM_HKDF_4KB file scheme) under a DISTINCT filename — this id
//      is not a signing secret the way the outbox device key is, but the
//      mechanism is already proven or the outbox, and reusing it means one
//      less at-rest storage pattern in this module.
//
// PRIVACY: the raw SSAID and any explicit override are HASHED (SHA-256 → UUID
// shape) before `AnnounceDevice.id` is ever composed — the raw hardware
// identifier never rides the wire. The stored-UUID fallback is already an
// opaque random id, so it ships as-is (mirrors `DeviceKey`'s "already random,
// nothing to scrub" reasoning). Facts are non-personal by design —
// `Settings.Global.getString(..., "device_name")` (the user-assigned device
// name) is deliberately never read anywhere in this file.
//
// NEVER throws. `resolve` returns null only when there is no explicit
// override, no readable SSAID, AND the storage fallback is unavailable
// (AndroidKeyStore failure) — callers must treat that as "omit the whole
// `device` block", exactly like `CompanionAnnounce`'s own
// all-failures-are-null contract.
package com.traceitx.companion

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.annotation.VisibleForTesting
import androidx.security.crypto.EncryptedFile
import androidx.security.crypto.MasterKey
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/**
 * The announce `device` block (naming spec 2026-08-24). Non-personal by
 * design — the user-assigned device name is deliberately never read anywhere
 * in this file.
 */
data class AnnounceDevice(
    /** Lowercase UUID — either hashed from an explicit/SSAID source or a
     *  stored random id. Never a raw hardware identifier. */
    val id: String,
    /** Always `"android"` on this SDK leg. */
    val platform: String = "android",
    /** `Build.MODEL`, e.g. `"Pixel 8"` / `"AFTKA"` (Fire TV). Capped to 80
     *  chars — matches the server schema (`announce-route.ts`). Null-safe:
     *  `Build.MODEL` reads back null under a plain (unmocked) JVM. */
    val model: String?,
    /** `"Android"`. Capped to 40 chars for symmetry with iOS/web, though this
     *  literal never exceeds it. */
    val osName: String?,
    /** `Build.VERSION.RELEASE`, e.g. `"14"`. Capped to 40 chars. */
    val osVersion: String?,
    /** Emulator heuristic — see [CompanionDeviceFacts.isEmulator]. */
    val emulator: Boolean,
)

/** Resolves the stable `device.id` — see the file header for the chain. */
object CompanionDeviceId {

    /**
     * Distinct from `outbox/DeviceKey.kt`'s `traceitx-device-key.enc` — this
     * id is a companion-discovery convenience, not the outbox's signing
     * identity, and the two must never collide on one file.
     */
    private const val FILE_NAME: String = "traceitx-companion-device-id.enc"

    /**
     * `explicit` (hashed SHA-256 → UUID shape) → SSAID (hashed) → a stored
     * random UUID (created + persisted on first use) → null (storage
     * unavailable and no usable explicit/SSAID source).
     */
    fun resolve(context: Context, explicit: String? = null): String? {
        if (!explicit.isNullOrBlank()) return hashToUuid(explicit)
        val ssaid = readSsaid(context)
        if (!ssaid.isNullOrBlank()) return hashToUuid(ssaid)
        return storedFallbackId(context)
    }

    /**
     * Test-only: deletes the persisted fallback id so a test can observe a
     * fresh [resolve] (with no explicit/SSAID source) creating a new one, and
     * so one test's persisted id can't leak into the next. Takes [context]
     * (unlike iOS's context-free `__resetForTests()`) because the Android
     * storage mechanism is filesDir-scoped, not a single process-global
     * Keychain entry.
     */
    @VisibleForTesting
    fun __resetForTests(context: Context) {
        runCatching { File(context.filesDir, FILE_NAME).delete() }
    }

    /**
     * `Settings.Secure.ANDROID_ID` — device-and-signing-key scoped, survives
     * app reinstall (but not a factory reset or a re-signed APK). Wrapped in
     * `runCatching`: a `SecurityException` from a locked-down content
     * resolver, or any other failure, must fall through to the stored-UUID
     * path rather than throw. SECURITY: the raw value is used ONLY as
     * [hashToUuid] input — it is never itself stored or returned.
     */
    private fun readSsaid(context: Context): String? = runCatching {
        Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    }.getOrNull()

    /**
     * Reuses `DeviceKey.kt`'s EncryptedFile mechanism (same master-key
     * scheme, same file-encryption scheme) under [FILE_NAME] — a distinct
     * file from the outbox's own device key. Returns null on ANY failure
     * (AndroidKeyStore unavailable, corrupted keystore) rather than throwing:
     * this id is a companion-discovery convenience, not load-bearing for
     * reporting, and the caller's contract for a null id is "omit the
     * `device` block", identical to every other failure mode in this file.
     */
    private fun storedFallbackId(context: Context): String? = runCatching {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val file = File(context.filesDir, FILE_NAME)
        val encryptedFile = EncryptedFile.Builder(
            context,
            file,
            masterKey,
            EncryptedFile.FileEncryptionScheme.AES256_GCM_HKDF_4KB,
        ).build()
        if (file.exists()) {
            encryptedFile.openFileInput().bufferedReader().use { it.readText() }
        } else {
            val fresh = UUID.randomUUID().toString().lowercase()
            encryptedFile.openFileOutput().bufferedWriter().use { it.write(fresh) }
            fresh
        }
    }.getOrNull()

    /**
     * Test-only probe: true iff the EncryptedFile/AndroidKeyStore mechanism
     * actually works on THIS JVM host. Mirrors iOS's
     * `DeviceKey.probeKeychainAvailability()` — a plain (unsigned) test
     * process, or a Robolectric host with no `AndroidKeyStore`
     * `java.security.Provider` registered, throws `KeyStoreException:
     * AndroidKeyStore not found` from `MasterKey.Builder(...).build()`
     * (measured on this repo's `robolectric = "4.13"` pin). Production code
     * never calls this — [storedFallbackId] already fails closed to null via
     * its own `runCatching`, exactly the behaviour this probe exists to let
     * a TEST tell apart from "the mechanism ran and produced null".
     */
    @VisibleForTesting
    fun __probeStorageAvailabilityForTests(context: Context): Boolean {
        __resetForTests(context)
        val probed = storedFallbackId(context)
        __resetForTests(context)
        return probed != null
    }

    /**
     * SHA-256 the source, take the first 16 bytes, stamp the version/variant
     * nibbles, format 8-4-4-4-12. Bit-for-bit mirror of `hashToUuid` in
     * `packages/sdk-react/src/companion/device-id.ts` and
     * `CompanionDeviceId.hashToUuid` in `CompanionDevice.swift` so the SAME
     * explicit source produces the SAME device id on every SDK platform.
     */
    @VisibleForTesting
    internal fun hashToUuid(source: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8))
        val bytes = digest.copyOf(16)
        bytes[6] = ((bytes[6].toInt() and 0x0f) or 0x40).toByte()
        bytes[8] = ((bytes[8].toInt() and 0x3f) or 0x80).toByte()
        val hex = bytes.joinToString("") { "%02x".format(it) }
        return "${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-" +
            "${hex.substring(16, 20)}-${hex.substring(20, 32)}"
    }
}

/**
 * Composes the full `AnnounceDevice` block: [CompanionDeviceId.resolve] plus
 * raw, non-personal facts about the host. `RelayWSClient`'s `deviceProvider`
 * seam calls this fresh on every announce — cheap enough (Build fields +
 * one hash, or one EncryptedFile read) that no caching layer is needed here
 * (contrast iOS's `RelayWSClient.resolveDeviceOnce`, which caches because it
 * additionally hits the Keychain).
 */
object CompanionDeviceFacts {

    /**
     * Null only when [CompanionDeviceId.resolve] fails — the caller's
     * contract is then "omit the whole `device` block", not "send one with a
     * missing id" (the server schema requires `id`).
     */
    fun current(context: Context, explicit: String? = null): AnnounceDevice? {
        val id = CompanionDeviceId.resolve(context, explicit) ?: return null
        return AnnounceDevice(
            id = id,
            platform = "android",
            model = cap(Build.MODEL, MODEL_MAX),
            osName = cap(OS_NAME, OS_FIELD_MAX),
            osVersion = cap(Build.VERSION.RELEASE, OS_FIELD_MAX),
            emulator = isEmulator(),
        )
    }

    private const val OS_NAME: String = "Android"
    private const val MODEL_MAX: Int = 80
    private const val OS_FIELD_MAX: Int = 40

    /**
     * Emulator heuristic (naming spec 2026-08-24): the same three signals
     * Android tooling has used for a decade to detect a stock AVD / Genymotion
     * / Google-Play-emulator image. Null-safe throughout — every `Build`
     * field involved reads back null under a plain (unmocked) JVM, which a
     * bare `.contains` call on a non-null-asserted String would otherwise NPE
     * on.
     */
    private fun isEmulator(): Boolean {
        val fingerprint = Build.FINGERPRINT
        val model = Build.MODEL
        val product = Build.PRODUCT
        return fingerprint?.contains("generic") == true ||
            fingerprint?.contains("emulator") == true ||
            model?.contains("sdk_gphone") == true ||
            product?.contains("sdk") == true
    }

    private fun cap(s: String?, n: Int): String? {
        if (s.isNullOrBlank()) return null
        return s.take(n)
    }
}
