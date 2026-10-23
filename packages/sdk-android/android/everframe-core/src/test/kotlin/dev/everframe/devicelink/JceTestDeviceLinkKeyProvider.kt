// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.devicelink

import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** In-memory AES key in place of AndroidKeyStore, which Robolectric does not provide. */
internal class JceTestDeviceLinkKeyProvider : DeviceLinkKeyProvider {
    var key: SecretKey? = null
    var deletes = 0
    var failWith: Throwable? = null

    override fun getOrCreate(): SecretKey {
        failWith?.let { throw it }
        return key ?: KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { key = it }
    }

    override fun delete() {
        deletes++
        key = null
    }
}
