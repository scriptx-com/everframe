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
// Native binaries are deliberately not downloaded or built by ordinary SDK tasks.
// An explicit, verified workspace opts into this optional publication.
if (providers.gradleProperty("everframeNativeBuildDir").isPresent) {
    include(":everframe-native-crash")
}
include(":everframe-reporter-ui")
include(":everframe-media3")
include(":everframe-gradle-plugin")

// Qualification-only host; absent from normal SDK builds and publications.
if (providers.gradleProperty("nativeImportQualification").orNull == "true") {
    include(":native-import-host")
    project(":native-import-host").projectDir = file("../tests/native-import-host/app")
}

if (providers.gradleProperty("nativeReleaseAcceptance").orNull == "true") {
    include(":native-release-host")
    project(":native-release-host").projectDir = file("../tests/native-release-host/app")
}

// Installed default-crash acceptance; absent from normal SDK builds and publications.
if (providers.gradleProperty("crashDefaultAcceptance").orNull == "true") {
    include(":crash-default-host")
    project(":crash-default-host").projectDir = file("../tests/crash-default-host/app")
}
