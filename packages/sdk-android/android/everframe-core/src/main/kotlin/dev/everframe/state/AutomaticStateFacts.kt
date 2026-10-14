// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.state
import android.Manifest
import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Bundle
import dev.everframe.capture.DeviceMetadata
import dev.everframe.protocol.generated.StateSnapshot
import dev.everframe.protocol.generated.StateValue
import java.util.Locale

internal class AutomaticStateFacts(private val context: Context, private val owner: Int, private val publish: (Int, Map<String, StateValue>) -> Unit) : Application.ActivityLifecycleCallbacks {
    private val app = context.applicationContext as? Application
    private var manager: ConnectivityManager? = null
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) { refresh() }
        override fun onLost(network: Network) { refresh() }
    }
    init {
        app?.registerActivityLifecycleCallbacks(this)
        if (Build.VERSION.SDK_INT >= 24 && context.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE) == PackageManager.PERMISSION_GRANTED) {
            val service = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            try { service?.registerDefaultNetworkCallback(callback); manager = service } catch (_: Exception) { }
        }
        refresh()
    }
    fun stop() { app?.unregisterActivityLifecycleCallbacks(this); try { manager?.unregisterNetworkCallback(callback) } catch (_: Exception) { }; manager = null }
    fun refresh() {
        val facts = mutableMapOf<String, StateValue>("locale" to StateValue.StringValue(Locale.getDefault().toLanguageTag()))
        fun put(key: String, value: String) { facts[key] = StateValue.StringValue(value) }
        val declared = try { context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions?.toSet().orEmpty() } catch (_: Exception) { emptySet() }
        fun permission(name: String) = if (name !in declared) "not-requested" else if (context.checkSelfPermission(name) == PackageManager.PERMISSION_GRANTED) "granted" else "denied"
        put("permission.camera", permission(Manifest.permission.CAMERA))
        put("permission.microphone", permission(Manifest.permission.RECORD_AUDIO))
        put("permission.notifications", try {
            if (Build.VERSION.SDK_INT >= 24) {
                val service = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                when (service?.areNotificationsEnabled()) { true -> "granted"; false -> "denied"; null -> "unknown" }
            } else "unknown"
        } catch (_: Exception) { "unknown" })
        put("network.type", try {
            if (context.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE) != PackageManager.PERMISSION_GRANTED) "unknown"
            else {
                val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                val network = cm?.activeNetwork
                val capabilities = network?.let { cm.getNetworkCapabilities(it) }
                when {
                    cm == null -> "unknown"
                    network == null -> "offline"
                    capabilities == null -> "unknown"
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wired"
                    else -> "other"
                }
            }
        } catch (_: Exception) { "unknown" })
        publish(owner, facts)
    }
    override fun onActivityResumed(activity: Activity) { refresh() }
    override fun onActivityCreated(activity: Activity, state: Bundle?) { }
    override fun onActivityStarted(activity: Activity) { }
    override fun onActivityPaused(activity: Activity) { }
    override fun onActivityStopped(activity: Activity) { }
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) { }
    override fun onActivityDestroyed(activity: Activity) { }
    companion object {
        fun initial(context: Context): StateSnapshot {
            val release = DeviceMetadata.appRelease(context, debugBuild = null)
            return StateSnapshot(mapOf(
                "app.version" to StateValue.StringValue(release.version),
                "app.build" to StateValue.StringValue(release.build ?: "unknown"),
                "os.name" to StateValue.StringValue("Android"), "os.version" to StateValue.StringValue(Build.VERSION.RELEASE ?: "unknown"),
                "locale" to StateValue.StringValue(Locale.getDefault().toLanguageTag()), "user.status" to StateValue.StringValue("anonymous"),
                "network.type" to StateValue.StringValue("unknown"), "permission.camera" to StateValue.StringValue("unknown"),
                "permission.microphone" to StateValue.StringValue("unknown"), "permission.notifications" to StateValue.StringValue("unknown")
            ), emptyMap())
        }
    }
}
