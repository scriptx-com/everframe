// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.app.Application
import android.content.Context
import android.os.Build
import java.io.File

/** Native and OS-exit crash capture belong to the default app process, the one named after the package. */
internal object AppProcess {
    fun isDefault(context: Context): Boolean = name() == context.packageName

    private fun name(): String = if (Build.VERSION.SDK_INT >= 28) Application.getProcessName()
        else File("/proc/self/cmdline").inputStream().use { input ->
            val bytes = ByteArray(256); val size = input.read(bytes)
            if (size <= 0) "" else bytes.copyOfRange(0, size).takeWhile { it != 0.toByte() }.toByteArray().toString(Charsets.UTF_8)
        }
}
