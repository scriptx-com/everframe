// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The (non-secret) install identifier this SDK reports on
// `GET /api/config?installId=<value>` for MAI ("monthly active install")
// metering — a display-only, per-(org, month) distinct-install count. NOT a
// user identifier and NOT authentication; never call it a "user id". One
// person with a phone, a tablet and the web app is three installs and one
// user.
//
// Kotlin port of `packages/sdk-ios/Sources/TraceItX/Config/InstallIdentifier
// .swift`. Unlike `DeviceKey.kt`, which deliberately diverges from its iOS
// counterpart by storing a UUID string, this one does NOT diverge: the seed is
// 16 raw bytes on every platform, because the cross-SDK vector fixes
// BYTES -> identifier and a UUID string is not a byte string on its own.
//
// WHY NOT `DeviceKey`. The spec originally had this derive from
// `outbox/DeviceKey.kt`, on the premise that reusing it needed no new storage.
// That premise was false: `DeviceKey` has no production call site on this
// platform (or on iOS) — nothing mints it. Reusing it would have meant
// STARTING to write an AndroidKeyStore-backed EncryptedFile on every install
// for a display-only meter, acquiring its throw-on-broken-Keystore path, its
// launch cost, and the Robolectric "AndroidKeyStore not found" gap that forces
// every storage test to probe-and-skip. See the spec's Counting architecture
// section, second amendment 2026-08-28.
//
// STORAGE. Plain `SharedPreferences`, not `EncryptedFile`: this value
// authenticates nothing and encrypting it would buy nothing but failure modes.
//
// NO READ-BACK, UNLIKE WEB. Web's `getOrCreateInstallSeed`
// (packages/sdk-react/src/reporter/credential-store.ts:207-217) reads its own
// `localStorage` write back immediately after minting, because several
// browser tabs can each reach an empty store concurrently and, without that
// read-back, each would keep its own freshly-minted seed for the tab's whole
// lifetime — the reviewer measured multiple seeds in 90 of 100 rounds of a
// 20-tab probe. `getOrCreateSeed` below is plain check-then-act with no such
// read-back, which is correct for the single-process-per-storage-domain case
// this SDK assumes: one app, one default `SharedPreferences` file. That
// assumption is not universal, though — an Android app with a second process
// (declared via `android:process` on a component) gets its OWN,
// non-shared `SharedPreferences` instance even for the same file name, so a
// user who triggers code in both processes would mint two seeds for what is
// really one install, permanently (there is no shared "last writer wins"
// store across processes for a read-back to converge on, unlike web's single
// origin). This is documented, not mitigated — see the review that
// introduced this note.
//
// NOT SCOPED ON THE SDK KEY, unlike web. Web scopes its storage key on the api
// key because one ORIGIN can host two apps with different keys, and that
// scoping is what prevents cross-org correlation there. This store is
// app-sandboxed, so scoping would buy no privacy — and it would re-mint every
// install identity on SDK-key rotation, already a known inflation defect on
// web. Do not "restore symmetry" here.
package com.traceitx.config

import android.content.Context
import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

internal object InstallIdentifier {

    /** Versioned so a future derivation change can bump to "-v2". Must equal
     *  `INSTALL_ID_DOMAIN_SEPARATOR` in sdk-core and `domainSeparator` in Swift. */
    const val DOMAIN_SEPARATOR: String = "traceitx-install-id-v1"

    /** 16 bytes -> 32 lowercase hex, same width web uses (`INSTALL_SEED_BYTES`). */
    private const val SEED_BYTES: Int = 16

    internal const val PREFS_NAME: String = "traceitx-install"
    internal const val SEED_KEY: String = "installSeed"
    internal const val DAY_KEY: String = "installIdLastSentDay"

    /** Exactly web's `INSTALL_SEED_HEX_RE`. A stored value of any other shape
     *  is discarded and re-minted rather than used. */
    private val HEX_RE = Regex("^[0-9a-f]{32}$")

    /**
     * The value the config read carries, or null when anything at all went
     * wrong. NEVER throws: the caller feeds this into the config URL, and that
     * read is the SDK's remote kill switch. An uncounted install is cosmetic;
     * a config fetch that never fires is not.
     */
    fun current(context: Context): String? = runCatching {
        val seed = getOrCreateSeed(context) ?: return@runCatching null
        derive(seed)
    }.getOrNull()

    /**
     * UTC day number — whole days since the epoch. Deliberately arithmetic
     * rather than a formatter/Calendar: web and iOS run the identical
     * expression, and three separate "what day is it in UTC" implementations
     * would be three chances to disagree in a way no single-platform test could
     * catch (each platform still dedupes correctly against its OWN past either
     * way).
     */
    internal fun utcDayNumber(nowMs: Long): Long = Math.floorDiv(nowMs, 86_400_000L)

    /**
     * The supplier handed to [ReplayConfigProvider] (MAI meter spec
     * 2026-08-27, D3). Yields the identifier at most once per install per UTC
     * day; every other call yields null, which the provider treats as "send the
     * config URL unchanged".
     *
     * The day is recorded at HAND-OVER — on dispatch, not on a successful
     * response. Recording on success would re-send through every failed fetch,
     * and a lost day costs nothing: the server deduplicates per calendar
     * MONTH, so any later day still counts this install. Nothing here retries.
     *
     * `enabled = false` (the client veto) returns a supplier that computes
     * nothing, stores nothing, and yields nothing — not one that derives and
     * discards.
     *
     * NEVER throws.
     */
    fun makeSupplier(
        context: Context,
        enabled: Boolean,
        now: () -> Long = { System.currentTimeMillis() },
    ): () -> String? {
        if (!enabled) return { null }
        val appContext = context.applicationContext
        return {
            runCatching {
                val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                val today = utcDayNumber(now())
                // A malformed or absent marker is treated as "not sent today"
                // rather than trusted: over-sending is free (the server's
                // unique constraint absorbs it), while trusting garbage could
                // suppress an install for a whole month.
                val stored = prefs.getString(DAY_KEY, null)?.toLongOrNull()
                if (stored == today) {
                    null
                } else {
                    val id = current(appContext)
                    if (id != null) prefs.edit().putString(DAY_KEY, today.toString()).apply()
                    id
                }
            }.getOrNull()
        }
    }

    /**
     * HMAC-SHA256(key = seed, message = domain separator), unpadded base64url.
     * The seed is the KEY, not the message: HMAC's PRF guarantee over the key
     * is what makes the seed unrecoverable from any number of outputs, even
     * for a fixed, publicly-known message.
     *
     * `android.util.Base64`, not `java.util.Base64` — the latter is API 26 and
     * this module's minSdk is 24. URL_SAFE gives the `-_` alphabet, NO_PADDING
     * drops the `=`, NO_WRAP drops the trailing newline URL_SAFE alone would
     * still emit.
     */
    fun derive(seed: ByteArray): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(seed, "HmacSHA256"))
        val digest = mac.doFinal(DOMAIN_SEPARATOR.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    internal fun getOrCreateSeed(context: Context): ByteArray? = runCatching {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val stored = prefs.getString(SEED_KEY, null)
        if (stored != null && HEX_RE.matches(stored)) return@runCatching hexToBytes(stored)
        val fresh = ByteArray(SEED_BYTES).also { SecureRandom().nextBytes(it) }
        prefs.edit().putString(SEED_KEY, bytesToHex(fresh)).apply()
        fresh
    }.getOrNull()

    private fun bytesToHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    private fun hexToBytes(hex: String): ByteArray =
        ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
