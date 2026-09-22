// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Multi-module declaration for the TraceItX Android SDK (Plan 05-01).
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

rootProject.name = "traceitx-android"

include(":traceitx-protocol")
include(":traceitx-core")
include(":traceitx-reporter-ui")
include(":traceitx-media3")
include(":traceitx-gradle-plugin")
