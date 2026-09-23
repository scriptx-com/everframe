// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.gradle

import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.SetProperty

public abstract class EverframeR8Extension {
    public abstract val enabled: Property<Boolean>
    public abstract val buildTypes: SetProperty<String>
    public abstract val buildId: Property<String>
    public abstract val appId: Property<String>
    public abstract val cliExecutable: Property<String>
    public abstract val cliArgs: ListProperty<String>
}
