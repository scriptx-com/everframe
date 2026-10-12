// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.SetProperty

/** The `everframe {}` block: uploads R8 mappings, native symbols and React Native Hermes source maps after release builds. */
public abstract class EverframeExtension {
    /** Everframe application UUID. Defaults to the `EVERFRAME_APP_ID` environment variable. */
    public abstract val appId: Property<String>
    /** Upload R8 mappings, native symbols and Hermes source maps of release builds. Defaults to true. */
    public abstract val uploadEnabled: Property<Boolean>
    /** Build types whose variants upload. Defaults to `release`. */
    public abstract val buildTypes: SetProperty<String>
    /** Command that runs the Everframe CLI. Defaults to `EVERFRAME_CLI_JS`, then node_modules, then a pinned `npx`. */
    public abstract val cliCommand: ListProperty<String>
    /**
     * React Native only: the `.everframe` folder `@everframe/metro` stages each bundle in.
     * Defaults to `.everframe` beside the `android` folder, in the app's root.
     */
    public abstract val hermesStagingDir: DirectoryProperty
}
