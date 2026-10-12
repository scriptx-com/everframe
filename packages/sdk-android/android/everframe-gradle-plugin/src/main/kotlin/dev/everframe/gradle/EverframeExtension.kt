// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.gradle

import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.SetProperty

/** The `everframe {}` block: uploads R8 mappings and native symbols after release builds. */
public abstract class EverframeExtension {
    /** Everframe application UUID. Defaults to the `EVERFRAME_APP_ID` environment variable. */
    public abstract val appId: Property<String>
    /** Upload R8 mappings and native symbols after `assemble<Variant>` and `bundle<Variant>`. Defaults to true. */
    public abstract val uploadEnabled: Property<Boolean>
    /** Build types whose variants upload. Defaults to `release`. */
    public abstract val buildTypes: SetProperty<String>
    /** Command that runs the Everframe CLI. Defaults to `EVERFRAME_CLI_JS`, then node_modules, then a pinned `npx`. */
    public abstract val cliCommand: ListProperty<String>
}
