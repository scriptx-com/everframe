// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TraceItXPackage — registers TraceItXModule with React Native's TurboModule
// manager. Hosts add this to their `getPackages()` list (Application or
// MainApplication.kt) to expose the bridge.
//
// Plan 06-03 — declares isTurboModule = true so the host's new-architecture
// codegen wires this through TurboModuleManagerDelegate; on legacy (paper)
// hosts, RN falls back to the same ReactContextBaseJavaModule surface.

package com.traceitx.rn

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class TraceItXPackage : BaseReactPackage() {

    override fun createViewManagers(reactContext: ReactApplicationContext): List<com.facebook.react.uimanager.ViewManager<*, *>> =
        listOf(TraceItXSensitiveViewManager())

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == TraceItXModule.NAME) TraceItXModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            TraceItXModule.NAME to ReactModuleInfo(
                /* name              = */ TraceItXModule.NAME,
                /* className         = */ TraceItXModule::class.java.name,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit    = */ false,
                /* isCxxModule       = */ false,
                /* isTurboModule     = */ true,
            ),
        )
    }
}
