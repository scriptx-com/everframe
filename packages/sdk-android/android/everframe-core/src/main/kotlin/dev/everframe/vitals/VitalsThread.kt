// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.vitals

import android.os.Handler
import android.os.HandlerThread

/** One process-lifetime background thread shared by the sampler, the flush timer and transport retries. */
internal object VitalsThread {
    val handler: Handler by lazy {
        val t = HandlerThread("everframe-vitals", android.os.Process.THREAD_PRIORITY_BACKGROUND)
        t.start()
        Handler(t.looper)
    }
}
