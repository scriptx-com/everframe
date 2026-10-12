// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager

/** Device-cost gates for native video (spec 2026-10-11). Reads are field loads, safe on every main tick. */
internal interface VideoDeviceConditions {
    /** Battery Saver is on, or the thermal status is MODERATE or higher: pause like a lost window. */
    fun pauseRecording(): Boolean
    /** [ActivityManager.isLowRamDevice]: recording never starts. */
    val lowRamDevice: Boolean
}

/**
 * Cached from the power-save change broadcast and the thermal listener, so a recorder tick never
 * makes a binder call. Process lifetime: registered once on the application context, never removed.
 */
internal class AndroidVideoDeviceConditions internal constructor(context: Context) : VideoDeviceConditions {
    private val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
    @Volatile private var powerSave = runCatching { power?.isPowerSaveMode == true }.getOrDefault(false)
    @Volatile private var thermal = PowerManager.THERMAL_STATUS_NONE
    private val thermalListening: Boolean = Build.VERSION.SDK_INT >= 29 && power != null && runCatching {
        val manager = checkNotNull(power)
        thermal = manager.currentThermalStatus
        manager.addThermalStatusListener { status -> thermal = status }
        true
    }.getOrDefault(false)
    override val lowRamDevice: Boolean = runCatching {
        (context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)?.isLowRamDevice == true
    }.getOrDefault(false)

    init {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                powerSave = runCatching { power?.isPowerSaveMode == true }.getOrDefault(false)
            }
        }
        val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        runCatching {
            if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else context.registerReceiver(receiver, filter)
        }
    }

    override fun pauseRecording(): Boolean {
        // Without a listener (registration failed), fall back to the per-tick read the recorder made before.
        val status = if (thermalListening || Build.VERSION.SDK_INT < 29) thermal
            else runCatching { power?.currentThermalStatus }.getOrNull() ?: PowerManager.THERMAL_STATUS_NONE
        return powerSave || status >= PowerManager.THERMAL_STATUS_MODERATE
    }

    companion object {
        @Volatile private var shared: AndroidVideoDeviceConditions? = null
        /** The first call registers the platform callbacks: make it off the report authorization lock. */
        fun of(context: Context): VideoDeviceConditions = shared ?: synchronized(this) {
            shared ?: AndroidVideoDeviceConditions(context.applicationContext ?: context).also { shared = it }
        }
    }
}
