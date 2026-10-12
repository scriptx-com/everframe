// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import android.content.Context
import android.content.pm.ApplicationInfo
import java.io.File

/**
 * The packaged handler executes from the installed native library directory, which exists only
 * when the app extracts native libraries. A library cannot set that: the app's own
 * `packaging.jniLibs.useLegacyPackaging` decides it for APKs and App Bundles.
 */
internal object AndroidNativeSignalPackaging {
    /** Documented not-ready reasons, logged as an `Everframe` warning before arming is attempted. */
    const val NOT_EXTRACTED = "native-libraries-not-extracted"
    const val HANDLER_MISSING = "native-handler-missing"
    private val executables = listOf("libeverframe_native_trampoline.so", "libeverframe_native_handler.so")

    /** Null for core-only apps and for an installed handler; otherwise the reason setup must stop. */
    fun refusal(modulePresent: Boolean, flags: Int, nativeLibraryDir: String?): String? = when {
        !modulePresent || (nativeLibraryDir != null && executables.all { File(nativeLibraryDir, it).isFile }) -> null
        flags and ApplicationInfo.FLAG_EXTRACT_NATIVE_LIBS == 0 -> NOT_EXTRACTED
        else -> HANDLER_MISSING
    }

    /** True when setup must stop before arming. The bounded warning names no path or identity. */
    fun refuses(context: Context, modulePresent: Boolean = modulePresent(context)): Boolean {
        val info = context.applicationInfo
        val reason = refusal(modulePresent, info.flags, info.nativeLibraryDir) ?: return false
        android.util.Log.w("Everframe", "Native signal capture not ready: $reason. " + when (reason) {
            NOT_EXTRACTED -> "Set android.packaging.jniLibs.useLegacyPackaging = true in the app."
            else -> "The installed app lacks the native-crash handler libraries for its ABI."
        })
        return true
    }

    fun modulePresent(context: Context): Boolean = try {
        Class.forName("dev.everframe.nativecrash.NativeCrashBridge", false, context.classLoader); true
    } catch (_: ClassNotFoundException) { false } catch (_: LinkageError) { false }
}
