// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories {
        System.getenv("MAVEN_LOCAL_REPOSITORY")?.takeIf { it.isNotBlank() }?.let {
            maven { url = uri(it) }
        }
        google()
        mavenCentral()
    }
}
rootProject.name = "kmp-compose-mobile-probe"
include(":everframeKmp")
project(":everframeKmp").projectDir = file("../../packages/everframe_kmp")
