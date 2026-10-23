// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Device link token storage.
//
// FILE. `noBackupFilesDir/dev.everframe/device-link-v1.bin`, so the token is
// never in a cloud backup or a device-to-device transfer. A copied file can't
// be decrypted anyway: the key lives in AndroidKeyStore on this device.
//
// FORMAT. Magic `EFDL`, version byte 1, a 12-byte IV, then AES-256-GCM
// ciphertext (128-bit tag, AAD `dev.everframe.devicelink.v1`) of
// `{"t":token,"k":"user"|"team","n":name?,"s":scope}`.
//
// NO EncryptedFile, for the reasons in `config/InstallIdentifier.kt`: its
// throw-on-broken-Keystore path and launch cost. Every public method catches
// Throwable; an unreadable file is deleted and the device is simply unlinked.
//
// SECURITY: never log the token or the decrypted payload.

package dev.everframe.devicelink

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal interface DeviceLinkKeyProvider {
    fun getOrCreate(): SecretKey
    fun delete()
}

internal class AndroidDeviceLinkKeyProvider(
    private val alias: String = "dev.everframe.devicelink.v1",
) : DeviceLinkKeyProvider {
    @Synchronized
    override fun getOrCreate(): SecretKey {
        val keyStore = keyStore()
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setKeySize(AES_KEY_BITS)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            generateKey()
        }
    }

    @Synchronized
    override fun delete() {
        keyStore().deleteEntry(alias)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }

    private companion object {
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val AES_KEY_BITS = 256
    }
}

internal class DeviceLinkStore(
    private val file: File,
    private val keys: DeviceLinkKeyProvider,
) {
    /** The stored link when it was issued for [scope]; null otherwise. A different scope keeps the file. */
    @Synchronized
    fun load(scope: String): StoredDeviceLink? = try {
        if (!file.exists()) {
            null
        } else {
            val link = decode(file.readBytes())
            if (link == null) {
                file.delete()
                null
            } else if (link.scope != scope) {
                null
            } else {
                link
            }
        }
    } catch (_: Throwable) {
        // Keystore unavailable or wiped, or the file is not ours: the device is unlinked.
        runCatching { file.delete() }
        null
    }

    @Synchronized
    fun save(link: StoredDeviceLink): Boolean = try {
        if (!DeviceLinkToken.isValid(link.token)) {
            false
        } else {
            val bytes = encode(link)
            file.parentFile?.mkdirs()
            val tmp = File(file.path + ".tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file)) {
                tmp.delete()
                false
            } else {
                true
            }
        }
    } catch (_: Throwable) {
        runCatching { File(file.path + ".tmp").delete() }
        false
    }

    @Synchronized
    fun clear() {
        runCatching { file.delete() }
        runCatching { File(file.path + ".tmp").delete() }
        runCatching { keys.delete() }
    }

    private fun encode(link: StoredDeviceLink): ByteArray {
        val payload = buildJsonObject {
            put("t", link.token)
            when (val owner = link.owner) {
                is DeviceLinkOwner.User -> {
                    put("k", "user")
                    put("n", owner.name)
                }
                DeviceLinkOwner.Team -> put("k", "team")
            }
            put("s", link.scope)
        }.toString().toByteArray(Charsets.UTF_8)
        val iv = ByteArray(IV_BYTES).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, keys.getOrCreate(), GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(AAD)
        val sealed = cipher.doFinal(payload)
        return MAGIC + byteArrayOf(VERSION) + iv + sealed
    }

    /** Null when the bytes are not a readable v1 record. Throws only from the key provider or cipher. */
    private fun decode(bytes: ByteArray): StoredDeviceLink? {
        val header = MAGIC.size + 1
        if (bytes.size < header + IV_BYTES + TAG_BITS / 8) return null
        if (!bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) return null
        if (bytes[MAGIC.size] != VERSION) return null
        val iv = bytes.copyOfRange(header, header + IV_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, keys.getOrCreate(), GCMParameterSpec(TAG_BITS, iv))
        cipher.updateAAD(AAD)
        val plain = cipher.doFinal(bytes, header + IV_BYTES, bytes.size - header - IV_BYTES)
        val obj: JsonObject = Json.parseToJsonElement(String(plain, Charsets.UTF_8)).jsonObject
        val token = (obj["t"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        val scope = (obj["s"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        if (!DeviceLinkToken.isValid(token) || scope.isNullOrEmpty()) return null
        val owner = when ((obj["k"] as? JsonPrimitive)?.contentOrNull) {
            "team" -> DeviceLinkOwner.Team
            "user" -> DeviceLinkOwner.User((obj["n"] as? JsonPrimitive)?.contentOrNull ?: "")
            else -> return null
        }
        return StoredDeviceLink(token!!, owner, scope)
    }

    companion object {
        const val RELATIVE_PATH: String = "dev.everframe/device-link-v1.bin"
        private val MAGIC = "EFDL".toByteArray(Charsets.US_ASCII)
        private const val VERSION: Byte = 1
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private val AAD = "dev.everframe.devicelink.v1".toByteArray(Charsets.US_ASCII)

        fun forContext(context: Context): DeviceLinkStore {
            val file = File(context.noBackupFilesDir, RELATIVE_PATH)
            runCatching { file.parentFile?.mkdirs() }
            return DeviceLinkStore(file, AndroidDeviceLinkKeyProvider())
        }
    }
}
