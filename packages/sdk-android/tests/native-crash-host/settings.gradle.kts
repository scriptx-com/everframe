// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement {
    repositories {
        maven { url = uri(providers.gradleProperty("everframeMavenRepo").get()) }
        google(); mavenCentral()
    }
}
rootProject.name = "EverframeNativeCrashProof"
include(":app")
