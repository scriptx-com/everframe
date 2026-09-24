// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// EverframePackage — registers EverframeModule with React Native's TurboModule
// manager. Hosts add this to their `getPackages()` list (Application or
// MainApplication.kt) to expose the bridge.
//
// Plan 06-03 — declares isTurboModule = true so the host's new-architecture
// codegen wires this through TurboModuleManagerDelegate; on legacy (paper)
// hosts, RN falls back to the same ReactContextBaseJavaModule surface.

package dev.everframe.rn

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class EverframePackage : BaseReactPackage() {

    override fun createViewManagers(reactContext: ReactApplicationContext): List<com.facebook.react.uimanager.ViewManager<*, *>> =
        listOf(EverframeSensitiveViewManager())

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == EverframeModule.NAME) EverframeModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            EverframeModule.NAME to ReactModuleInfo(
                /* name              = */ EverframeModule.NAME,
                /* className         = */ EverframeModule::class.java.name,
                /* canOverrideExistingModule = */ false,
                /* needsEagerInit    = */ false,
                /* isCxxModule       = */ false,
                /* isTurboModule     = */ true,
            ),
        )
    }
}
