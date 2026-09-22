// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package com.traceitx.capture.video

/** Main-thread-only immutable ancestry metadata; contains no View or privacy state. */
internal class VideoPrivacyTypeCache(
    private val superclassOf: (Class<*>) -> Class<*>? = { it.superclass },
) {
    class Types(val reactNative: Boolean, val composeHost: Boolean)

    // First 64 distinct classes per gate: bounded class-loader retention and no eviction churn
    // during repeated tree scans. Overflow still gets the full classification each time.
    private val cached = HashMap<Class<*>, Types>(64)

    fun classify(viewType: Class<*>): Types? {
        return try {
            cached[viewType]?.let { return it }
            var reactNative = false
            var composeHost = false
            var type: Class<*>? = viewType
            while (type != null) {
                val name = type.name
                if (name.startsWith("com.facebook.react.")) reactNative = true
                if (name == "androidx.compose.ui.platform.AndroidComposeView") composeHost = true
                type = superclassOf(type)
            }
            Types(reactNative, composeHost).also {
                if (cached.size < 64) cached[viewType] = it
            }
        } catch (_: Throwable) {
            // An incomplete ancestry walk is unknown; never memoize it as an ordinary View.
            null
        }
    }
}
