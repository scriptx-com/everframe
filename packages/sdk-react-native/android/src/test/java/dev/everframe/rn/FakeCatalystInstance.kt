// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared test double: a minimal `CatalystInstance` so Robolectric tests can
// call `BridgeReactContext.initializeWithInstance(...)` without a real JS
// runtime. Used by `ReporterBridgeTest`.
package dev.everframe.rn

import android.content.res.AssetManager
import com.facebook.react.bridge.CatalystInstance
import com.facebook.react.bridge.JavaScriptContextHolder
import com.facebook.react.bridge.JavaScriptModule
import com.facebook.react.bridge.NativeArray
import com.facebook.react.bridge.NativeArrayInterface
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.NativeModuleRegistry
import com.facebook.react.bridge.RuntimeExecutor
import com.facebook.react.bridge.RuntimeScheduler
import com.facebook.react.bridge.UIManager
import com.facebook.react.bridge.queue.MessageQueueThread
import com.facebook.react.bridge.queue.ReactQueueConfiguration
import com.facebook.react.internal.turbomodule.core.interfaces.TurboModuleRegistry
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.turbomodule.core.interfaces.CallInvokerHolder
import com.facebook.react.turbomodule.core.interfaces.NativeMethodCallInvokerHolder

/**
 * Minimal `CatalystInstance` stand-in. Only [getJSModule] does real work (it
 * always hands back the no-op [FakeRCTDeviceEventEmitter], regardless of
 * which `JavaScriptModule` class is requested); every other member just
 * satisfies the interface.
 */
internal class FakeCatalystInstance : CatalystInstance {
    private val emitter = FakeRCTDeviceEventEmitter()

    override fun runJSBundle() = Unit
    override fun hasRunJSBundle(): Boolean = true
    override val sourceURL: String? = null
    override fun invokeCallback(callbackID: Int, arguments: NativeArrayInterface) = Unit
    override fun callFunction(module: String, method: String, arguments: NativeArray?) = Unit
    override fun destroy() = Unit
    override val isDestroyed: Boolean = false
    override fun initialize() = Unit
    // `BridgeReactContext.initializeWithInstance` reads this EAGERLY (to
    // stand up its message-queue threads), so — unlike every other member
    // here — this one must be a real, working configuration, not a stub.
    // `ReactQueueConfigurationImpl` (the production factory) is `internal`
    // to RN's own compiled module and unreachable from here, so this is a
    // minimal hand-rolled one instead: every queue just runs its work
    // synchronously on the calling thread.
    override val reactQueueConfiguration: ReactQueueConfiguration = FakeReactQueueConfiguration()

    @Suppress("UNCHECKED_CAST")
    override fun <T : JavaScriptModule> getJSModule(jsInterface: Class<T>): T = emitter as T
    override fun <T : NativeModule> hasNativeModule(nativeModuleInterface: Class<T>): Boolean = false
    override fun <T : NativeModule> getNativeModule(nativeModuleInterface: Class<T>): T? = null
    override fun getNativeModule(name: String): NativeModule? = null
    override val nativeModules: Collection<NativeModule> = emptyList()
    override fun extendNativeModules(modules: NativeModuleRegistry) = Unit
    override fun registerSegment(segmentId: Int, path: String) = Unit
    override fun setGlobalVariable(propName: String, jsonValue: String) = Unit
    override val javaScriptContextHolder: JavaScriptContextHolder
        get() = throw UnsupportedOperationException("not needed by these tests")
    override val runtimeExecutor: RuntimeExecutor? = null
    override val runtimeScheduler: RuntimeScheduler? = null
    override val jsCallInvokerHolder: CallInvokerHolder
        get() = throw UnsupportedOperationException("not needed by these tests")
    override val nativeMethodCallInvokerHolder: NativeMethodCallInvokerHolder
        get() = throw UnsupportedOperationException("not needed by these tests")
    override fun setTurboModuleRegistry(turboModuleRegistry: TurboModuleRegistry) = Unit
    override fun setFabricUIManager(fabricUIManager: UIManager) = Unit
    override fun getFabricUIManager(): UIManager? = null
    override fun handleMemoryPressure(level: Int) = Unit
    override fun loadScriptFromAssets(assetManager: AssetManager, assetURL: String, loadSynchronously: Boolean) = Unit
    override fun loadScriptFromFile(fileName: String, sourceURL: String, loadSynchronously: Boolean) = Unit
    override fun loadSplitBundleFromFile(fileName: String, sourceURL: String) = Unit
    override fun setSourceURLs(deviceURL: String, remoteURL: String) = Unit
}

/** Runs everything synchronously on the calling thread — see
 *  [FakeCatalystInstance.reactQueueConfiguration]'s comment. */
private class FakeMessageQueueThread : MessageQueueThread {
    override fun runOnQueue(runnable: Runnable): Boolean {
        runnable.run()
        return true
    }

    override fun <T> callOnQueue(callable: java.util.concurrent.Callable<T>): java.util.concurrent.Future<T> {
        val result = callable.call()
        return java.util.concurrent.CompletableFuture.completedFuture(result)
    }

    override fun isOnThread(): Boolean = true
    override fun assertIsOnThread() = Unit
    override fun assertIsOnThread(message: String) = Unit
    override fun quitSynchronous() = Unit
    override fun isIdle(): Boolean = true
}

private class FakeReactQueueConfiguration : ReactQueueConfiguration {
    private val thread = FakeMessageQueueThread()
    override fun getUIQueueThread(): MessageQueueThread = thread
    override fun getNativeModulesQueueThread(): MessageQueueThread = thread
    override fun getJSQueueThread(): MessageQueueThread = thread
    override fun destroy() = Unit
}

/** No-op emitter — tests only need `getJSModule` to resolve to something. */
private class FakeRCTDeviceEventEmitter : DeviceEventManagerModule.RCTDeviceEventEmitter {
    override fun emit(eventName: String, data: Any?) = Unit
}
