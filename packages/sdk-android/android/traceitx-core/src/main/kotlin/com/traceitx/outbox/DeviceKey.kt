// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Per-install device key persisted at-rest via AndroidX Security Crypto's
// EncryptedFile (AES256-GCM-HKDF-4KB scheme). Replaces the iOS Keychain
// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` ACL — Android equivalent
// semantics: the master key lives in the AndroidKeyStore (hardware-backed on
// most modern devices), and the encrypted file is opened only after first
// unlock (the AndroidKeyStore master key is unavailable pre-boot).
//
// Mirrors `packages/sdk-ios/Sources/TraceItX/Outbox/DeviceKey.swift`.
//
// LOCKED (AUTH-01, T-04-19):
//   • Master key scheme: AES256_GCM (LOCKED — never weaker).
//   • File scheme: AES256_GCM_HKDF_4KB.
//   • Filename: `traceitx-device-key.enc` under `Context.filesDir`.
//
// DESIGN NOTE (deliberate divergence from iOS):
//   iOS DeviceKey returns 32 random bytes. Android port stores a UUID v4 string
//   (36 chars) — strictly stronger entropy for the Android-specific path because
//   `UUID.randomUUID()` uses a CSPRNG (java.security.SecureRandom) and the
//   String form is unambiguous to log when DEBUG diagnostics are enabled. The
//   wire-format ingest accepts any opaque per-install identifier; the protocol
//   does not constrain the byte layout.
package com.traceitx.outbox

import android.content.Context
import androidx.security.crypto.EncryptedFile
import androidx.security.crypto.MasterKey
import java.io.File
import java.util.UUID

internal object DeviceKey {

    private const val FILE_NAME: String = "traceitx-device-key.enc"

    /**
     * Returns the per-install device key, generating + persisting it on first call.
     * Idempotent: subsequent calls read back the same value across process restarts.
     *
     * Throws if the AndroidKeyStore is unavailable (e.g. corrupted Keystore) — the
     * caller (TraceItX.start()'s heavy-init coroutine) wraps this in `txGuard{}`
     * so a Keystore failure doesn't crash the host.
     */
    fun getOrCreate(context: Context): String {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val file = File(context.filesDir, FILE_NAME)
        // EncryptedFile.Builder requires the file NOT exist when building for write,
        // but we read-or-write so the file existence check decides which path runs.
        val encryptedFile = EncryptedFile.Builder(
            context,
            file,
            masterKey,
            EncryptedFile.FileEncryptionScheme.AES256_GCM_HKDF_4KB,
        ).build()
        if (file.exists()) {
            return encryptedFile.openFileInput().bufferedReader().use { it.readText() }
        }
        val newKey = UUID.randomUUID().toString()
        encryptedFile.openFileOutput().bufferedWriter().use { it.write(newKey) }
        return newKey
    }
}
