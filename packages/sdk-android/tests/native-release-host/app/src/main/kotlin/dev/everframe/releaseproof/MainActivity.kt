// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.releaseproof

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import android.widget.TextView
import dev.everframe.Everframe
import dev.everframe.config.CaptureConfig
import dev.everframe.config.EverframeConfig
import dev.everframe.config.VitalsConfig
import java.io.File

/** Installed acceptance client. Uses only the same public SDK methods as a customer app. */
open class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var label: TextView
    private external fun fault(worker: Boolean)
    private external fun foreignHandler()
    private external fun signalOwners(): String
    private external fun nullCall()
    private external fun splitMappings(pairs: Int): Int
    private external fun plusModuleFault()
    private var webView: WebView? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        System.loadLibrary("everframe_release_fault")
        label = TextView(this); setContentView(label)
        val mode = intent.getStringExtra("mode") ?: "recover"
        if (mode == "foreign") foreignHandler()
        // Thousands of mappings below the dynamic linker before the first arm.
        if (mode == "mappings") File(filesDir, "mappings.txt").writeText("${splitMappings(3000)} ${File("/proc/self/maps").readLines().size}")
        fun config(suffix: String = "", crash: Boolean = true) = EverframeConfig(
            appId = requireNotNull(intent.getStringExtra("appId$suffix")),
            sdkKey = requireNotNull(intent.getStringExtra("sdkKey$suffix")),
            release = intent.getStringExtra("release$suffix") ?: "release-A",
            capture = CaptureConfig(screenshot=false, focus=false, logs=false, network=false, crash=crash, networkBodies=false),
            bubble=false, companionBadgeEnabled=false, shakeToReportEnabled=false,
            installIdentifierEnabled=false, vitals=VitalsConfig(enabled=false))
        Everframe.start(applicationContext, config(), this)
        // Initializing WebView installs its in-process crash handler before the opt-in.
        if (mode == "webview-before") webView = WebView(this)
        File(filesDir, "signal-owners.txt").writeText(signalOwners())
        if (mode != "no-optin") Everframe.setNativeSignalCaptureEnabled(true)
        if (mode == "secondary-disable") { Everframe.setNativeSignalCaptureEnabled(false); Everframe.kill() }
        var attempts = 0
        fun status(state: String) {
            val text = "{\"state\":\"$state\",\"ready\":${Everframe.isNativeSignalCaptureReady()},\"delivery\":${Everframe.getReportDeliveryStatus().toJson()}}"
            File(filesDir, "acceptance-status.json").writeText(text)
            label.text = state; android.util.Log.i("EverframeReleaseProof", text)
        }
        val poll = object : Runnable {
            override fun run() {
                val ready = Everframe.isNativeSignalCaptureReady()
                if (mode in listOf("foreign", "absent", "no-optin", "secondary-disable")) {
                    if (++attempts < 20) { handler.postDelayed(this, 100); return }
                    status(if (ready) "unexpected-ready" else "refused"); return
                }
                if (!ready) {
                    status("waiting")
                    if (++attempts < 200) handler.postDelayed(this, 100) else status("timeout")
                    return
                }
                status("ready")
                when (mode) {
                    "main", "worker", "mappings", "webview-before" -> { status("faulting"); handler.postDelayed({ fault(mode == "worker") }, 300) }
                    "null-call" -> { status("faulting"); handler.postDelayed({ nullCall() }, 300) }
                    "plus-module" -> { System.loadLibrary("everframe_release+plus"); status("faulting"); handler.postDelayed({ plusModuleFault() }, 300) }
                    "webview-after" -> {
                        // WebView's handler now precedes the armed one; opting in again must re-arm.
                        webView = WebView(this@MainActivity)
                        File(filesDir, "signal-owners-webview.txt").writeText(signalOwners())
                        Everframe.setNativeSignalCaptureEnabled(true)
                        var waits = 0
                        handler.postDelayed(object: Runnable { override fun run() { if (Everframe.isNativeSignalCaptureReady()) { status("re-armed"); fault(false) } else if (++waits < 200) handler.postDelayed(this, 100) else status("timeout") } }, 100)
                    }
                    "disable" -> { Everframe.setNativeSignalCaptureEnabled(false); status("disabled"); handler.postDelayed({ fault(false) }, 300) }
                    "kill" -> { Everframe.kill(); status("killed"); handler.postDelayed({ fault(false) }, 300) }
                    "paused" -> { Everframe.start(applicationContext, config(crash=false), this@MainActivity); status("paused"); handler.postDelayed({ fault(false) }, 300) }
                    "reenable" -> { Everframe.setNativeSignalCaptureEnabled(false); Everframe.setNativeSignalCaptureEnabled(true); handler.postDelayed(object: Runnable { override fun run() { if (Everframe.isNativeSignalCaptureReady()) { status("re-enabled"); fault(false) } else handler.postDelayed(this, 100) } }, 100) }
                    "cycles" -> {
                        var cycle = 0
                        val next = object: Runnable {
                            override fun run() {
                                if (!Everframe.isNativeSignalCaptureReady()) { handler.postDelayed(this, 100); return }
                                if (cycle == 12) { status("cycled"); fault(false); return }
                                Everframe.start(applicationContext, config(if (cycle++ % 2 == 0) "B" else ""), this@MainActivity)
                                Everframe.setNativeSignalCaptureEnabled(true); handler.postDelayed(this, 100)
                            }
                        }
                        handler.post(next)
                    }
                    "replace" -> { Everframe.start(applicationContext, config("B"), this@MainActivity); Everframe.setNativeSignalCaptureEnabled(true); handler.postDelayed(object: Runnable { override fun run() { if (Everframe.isNativeSignalCaptureReady()) { status("replaced"); fault(false) } else handler.postDelayed(this, 100) } }, 100) }
                    else -> handler.postDelayed(object: Runnable { override fun run() { status("recovering"); handler.postDelayed(this, 1000) } }, 1000)
                }
            }
        }
        handler.postDelayed(poll, 300)
    }
}

class SecondaryActivity : MainActivity()
