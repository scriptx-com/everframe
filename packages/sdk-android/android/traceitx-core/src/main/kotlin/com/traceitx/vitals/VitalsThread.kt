// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.vitals

import android.os.Handler
import android.os.HandlerThread

/** One process-lifetime background thread shared by the sampler, the flush timer and transport retries. */
internal object VitalsThread {
    val handler: Handler by lazy {
        val t = HandlerThread("traceitx-vitals", android.os.Process.THREAD_PRIORITY_BACKGROUND)
        t.start()
        Handler(t.looper)
    }
}
