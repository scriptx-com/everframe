// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.trigger

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import dev.everframe.Everframe
import dev.everframe.config.EverframeConfig
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlin.math.abs

/** React Native/Expo-style shake recognizer, rewritten here to keep core dependency-free. */
internal class ShakeGestureDetector {
    private var accelerationX = 0f
    private var accelerationY = 0f
    private var accelerationZ = 0f
    private var lastTimestamp = -1L
    private var shakeCount = 0
    private var lastShakeTimestamp = 0L

    fun onAcceleration(timestampNs: Long, x: Float, y: Float, z: Float): Boolean {
        if (lastTimestamp >= 0 && timestampNs - lastTimestamp < MIN_SAMPLE_INTERVAL_NS) {
            return false
        }
        lastTimestamp = timestampNs
        val adjustedZ = z - SensorManager.GRAVITY_EARTH

        when {
            hasRequiredForce(x) && x * accelerationX <= 0 -> {
                recordShake(timestampNs)
                accelerationX = x
            }
            hasRequiredForce(y) && y * accelerationY <= 0 -> {
                recordShake(timestampNs)
                accelerationY = y
            }
            hasRequiredForce(adjustedZ) && adjustedZ * accelerationZ <= 0 -> {
                recordShake(timestampNs)
                accelerationZ = adjustedZ
            }
        }

        if (shakeCount >= REQUIRED_SHAKES) {
            resetShakeCount()
            return true
        }
        if (timestampNs - lastShakeTimestamp > SHAKING_WINDOW_NS) resetShakeCount()
        return false
    }

    fun reset() {
        lastTimestamp = -1L
        lastShakeTimestamp = 0L
        resetShakeCount()
    }

    private fun hasRequiredForce(acceleration: Float): Boolean =
        abs(acceleration) > REQUIRED_FORCE

    private fun recordShake(timestampNs: Long) {
        lastShakeTimestamp = timestampNs
        shakeCount += 1
    }

    private fun resetShakeCount() {
        shakeCount = 0
        accelerationX = 0f
        accelerationY = 0f
        accelerationZ = 0f
    }

    private companion object {
        val MIN_SAMPLE_INTERVAL_NS = TimeUnit.MILLISECONDS.toNanos(20)
        val SHAKING_WINDOW_NS = TimeUnit.SECONDS.toNanos(3)
        const val REQUIRED_SHAKES = 8
        const val REQUIRED_FORCE = SensorManager.GRAVITY_EARTH * 1.33f
    }
}

internal class ShakeToReportGate(localEnabled: Boolean) {
    @Volatile var localEnabled: Boolean = localEnabled
    @Volatile var remoteEnabled: Boolean? = null
    @Volatile var foreground: Boolean = false

    /**
     * Real-device quick capture: the gesture is armed for a capture or a link hello
     * (`CaptureGesture.isArmed`). Shake then listens whatever the shake-to-report switches say; those only
     * decide whether an unlinked release phone opens the reporter.
     */
    @Volatile var gestureArmed: Boolean = false
    private var inFlight = false

    /** Whether the accelerometer should be registered. */
    fun shouldListen(): Boolean = foreground && ((localEnabled && remoteEnabled == true) || gestureArmed)

    /** The local and dashboard shake-to-report switches: may a shake open the reporter. */
    val reporterAllowed: Boolean get() = localEnabled && remoteEnabled == true

    /**
     * [quickCaptureInFlight]: an emulator quick capture holds the frozen evidence until it finishes, so a
     * shake then would freeze over it.
     */
    @Synchronized
    fun tryBegin(presenting: Boolean, quickCaptureInFlight: Boolean = false): Boolean {
        if (!localEnabled || remoteEnabled != true || !foreground || presenting || quickCaptureInFlight || inFlight) return false
        inFlight = true
        return true
    }

    @Synchronized
    fun complete() {
        inFlight = false
    }
}

/** Process-owned native trigger. No permission and no required hardware declaration are needed. */
internal object ShakeToReportTrigger : SensorEventListener, Application.ActivityLifecycleCallbacks {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var generation = 0
    private var application: Application? = null
    private var sensorManager: SensorManager? = null
    private var accelerometer: Sensor? = null
    private var registered = false
    private var resumedActivity: Activity? = null
    private var gate = ShakeToReportGate(localEnabled = false)
    private var detector = ShakeGestureDetector()

    /**
     * The host's local switches. A crash-only session (`reporterEnabled = false`, spec 2026-10-12) turns
     * every on-device entry point off, shake included, whatever `shakeToReportEnabled` says.
     */
    internal fun localEnabled(config: EverframeConfig): Boolean =
        config.shakeToReportEnabled && config.reporterEnabled

    /** Test seam: opens the reporter for a shake. */
    @Volatile
    internal var reporterOpener: suspend () -> Unit = { Everframe.report.open(dev.everframe.config.ReporterTrigger.Shake) }

    /** The shake-to-report switches of the current session (see [ShakeToReportGate.reporterAllowed]). */
    val reporterAllowed: Boolean get() = synchronized(lock) { gate }.reporterAllowed

    /**
     * [localEnabled] is the host's shake-to-report switch ([localEnabled] of the config). [reporterEnabled]
     * false (a crash-only session) installs nothing at all; otherwise shake also runs while the capture
     * gesture is armed ([publishGestureArmed]). Shake never runs on a TV.
     */
    fun install(
        context: Context,
        localEnabled: Boolean,
        reporterEnabled: Boolean = localEnabled,
        currentActivity: Activity?,
        isCurrent: () -> Boolean,
    ) {
        if (!isCurrent()) return
        val app = context.applicationContext as? Application ?: return
        val nextGeneration = synchronized(lock) {
            generation += 1
            gate = ShakeToReportGate(localEnabled).also { it.foreground = currentActivity != null }
            detector = ShakeGestureDetector()
            generation
        }
        mainHandler.post {
            if (!isCurrent()) return@post
            synchronized(lock) {
                if (generation != nextGeneration) return@synchronized
                teardownPlatformLocked()
                if (!reporterEnabled || isTelevision(app)) return@synchronized
                val nextSensorManager = app.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
                val nextAccelerometer = nextSensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
                    ?: return@synchronized
                application = app
                resumedActivity = currentActivity
                sensorManager = nextSensorManager
                accelerometer = nextAccelerometer
                app.registerActivityLifecycleCallbacks(this)
                reconcileRegistrationLocked()
            }
        }
    }

    fun publishRemote(enabled: Boolean?, isCurrent: () -> Boolean) {
        if (!isCurrent()) return
        synchronized(lock) { gate.remoteEnabled = enabled }
        mainHandler.post {
            if (!isCurrent()) return@post
            synchronized(lock) { reconcileRegistrationLocked() }
        }
    }

    /** Real-device quick capture: whether the capture gesture is armed (see [ShakeToReportGate.gestureArmed]). */
    fun publishGestureArmed(armed: Boolean, isCurrent: () -> Boolean) {
        if (!isCurrent()) return
        synchronized(lock) { gate.gestureArmed = armed }
        mainHandler.post {
            if (!isCurrent()) return@post
            synchronized(lock) { reconcileRegistrationLocked() }
        }
    }

    fun teardown(isCurrent: () -> Boolean = { true }) {
        if (!isCurrent()) return
        synchronized(lock) {
            generation += 1
            gate.remoteEnabled = null
            gate.gestureArmed = false
            gate.foreground = false
        }
        mainHandler.post {
            if (!isCurrent()) return@post
            synchronized(lock) { teardownPlatformLocked() }
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ACCELEROMETER || event.values.size < 3) return
        if (!detector.onAcceleration(event.timestamp, event.values[0], event.values[1], event.values[2])) return
        onShake()
    }

    /**
     * One detected shake. Ignored while a quick capture holds the frozen evidence or the reporter is on
     * screen; otherwise the mode rule decides (`CaptureGesture`): a capture, a link hello, and the reporter
     * only when the decision and the shake-to-report switches both allow it.
     */
    internal fun onShake() {
        if (dev.everframe.quickcapture.QuickCapture.isCapturing || Everframe.report.isPresenting.value) return
        val decision = dev.everframe.quickcapture.CaptureGesture.onGesture(dev.everframe.quickcapture.GestureSource.Shake)
        if (!decision.openReporter) return
        val gate = synchronized(lock) { gate }
        if (!tryBeginShake(gate)) return
        Everframe.sdkScope.launch(Dispatchers.Main.immediate) {
            try {
                reporterOpener()
            } catch (_: Throwable) {
                // Core can be used without reporter-ui; a gesture is a safe no-op then.
            } finally {
                gate.complete()
            }
        }
    }

    /**
     * Shake only. An explicit `report.open()` during a quick capture still proceeds
     * (see `QuickCapture.isCapturing`).
     */
    internal fun tryBeginShake(gate: ShakeToReportGate): Boolean = gate.tryBegin(
        presenting = Everframe.report.isPresenting.value,
        quickCaptureInFlight = dev.everframe.quickcapture.QuickCapture.isCapturing,
    )

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    override fun onActivityResumed(activity: Activity) {
        synchronized(lock) {
            resumedActivity = activity
            gate.foreground = true
            reconcileRegistrationLocked()
        }
    }

    override fun onActivityPaused(activity: Activity) {
        synchronized(lock) {
            if (resumedActivity === activity) {
                resumedActivity = null
                gate.foreground = false
                reconcileRegistrationLocked()
            }
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit

    private fun reconcileRegistrationLocked() {
        val shouldRegister = gate.shouldListen() && accelerometer != null
        if (shouldRegister && !registered) {
            registered = sensorManager?.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_UI) == true
        } else if (!shouldRegister && registered) {
            sensorManager?.unregisterListener(this)
            registered = false
            detector.reset()
        }
    }

    private fun teardownPlatformLocked() {
        if (registered) sensorManager?.unregisterListener(this)
        application?.unregisterActivityLifecycleCallbacks(this)
        application = null
        sensorManager = null
        accelerometer = null
        resumedActivity = null
        registered = false
        detector.reset()
    }

    /** Tests only: the foreground flag an Activity resume or pause would set. */
    internal fun __setForegroundForTesting(foreground: Boolean) {
        synchronized(lock) {
            gate.foreground = foreground
            reconcileRegistrationLocked()
        }
    }

    /** Tests only. */
    internal fun __resetForTesting() {
        reporterOpener = { Everframe.report.open(dev.everframe.config.ReporterTrigger.Shake) }
    }

    /** Amazon's documented system feature for identifying Fire TV devices. */
    internal const val FIRE_TV_FEATURE = "amazon.hardware.fire_tv"

    @Suppress("DEPRECATION")
    internal fun isTelevision(context: Context): Boolean {
        val type = context.resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK
        return isTelevision(
            uiModeType = type,
            hasLeanback = context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK),
            hasTelevisionFeature = context.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEVISION),
            hasFireTvFeature = context.packageManager.hasSystemFeature(FIRE_TV_FEATURE),
        )
    }

    internal fun isTelevision(
        uiModeType: Int,
        hasLeanback: Boolean,
        hasTelevisionFeature: Boolean,
        hasFireTvFeature: Boolean = false,
    ): Boolean = uiModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
        hasLeanback || hasTelevisionFeature || hasFireTvFeature
}
