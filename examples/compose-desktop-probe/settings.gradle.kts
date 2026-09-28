// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        google()
    }
}

rootProject.name = "everframe-compose-desktop-probe"
