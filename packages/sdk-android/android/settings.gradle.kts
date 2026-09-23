// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Multi-module declaration for the Everframe Android SDK (Plan 05-01).
pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "everframe-android"

include(":everframe-protocol")
include(":everframe-core")
include(":everframe-reporter-ui")
include(":everframe-media3")
include(":everframe-gradle-plugin")
