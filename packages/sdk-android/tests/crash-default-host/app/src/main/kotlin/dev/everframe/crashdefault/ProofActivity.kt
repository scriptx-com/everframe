// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crashdefault

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.TextView
import dev.everframe.Everframe

/** Triggers one real failure once crash capture is armed. Status goes to logcat only (no root needed). */
class ProofActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private external fun segv()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "Crash default acceptance"; isFocusable = true })
        val crash = intent.getStringExtra("crash") ?: "none"
        var waits = 0
        handler.post(object : Runnable {
            override fun run() {
                val ready = Everframe.isNativeCrashCaptureReady()
                if (!ready && ++waits < 300) { handler.postDelayed(this, 100); return }
                Log.i(TAG, "state=${if (ready) "ready" else "timeout"} crash=$crash delivery=${Everframe.getReportDeliveryStatus().toJson()}")
                if (!ready) return
                when (crash) {
                    "jvm" -> handler.postDelayed({ throw IllegalStateException("crash-default-proof jvm") }, 300)
                    "segv" -> { System.loadLibrary("crash_default_fault"); handler.postDelayed({ segv() }, 300) }
                    "anr" -> handler.postDelayed({ Log.i(TAG, "state=blocking"); blockMainThread() }, 300)
                }
            }
        })
    }

    /** Holds the main looper so a real input event makes the OS declare an ANR. */
    private fun blockMainThread() { Thread.sleep(120_000) }

    private companion object { const val TAG = "EverframeCrashDefault" }
}
