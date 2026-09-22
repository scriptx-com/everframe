// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TraceItX View XML sample app (Java consumer demo). Consumes the SDK
// from mavenLocal — matching the android-compose and react-native samples.
// `pnpm dev:example:android` re-publishes the SDK to `~/.m2/repository/com/traceitx/`
// before the install, so the consumed AARs are never older than the
// current SDK source. See `examples/android-compose/settings.gradle.kts`
// for the full rationale.

pluginManagement {
    repositories {
        gradlePluginPortal()
        google()
        mavenCentral()
        mavenLocal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // mavenLocal FIRST — same trap as the Compose sample; see
        // examples/android-compose/settings.gradle.kts for the full rationale.
        // `com.traceitx:core` exists on Maven Central at the same coordinates,
        // so with mavenLocal last a locally published AAR is silently ignored.
        mavenLocal()
        google()
        mavenCentral()
    }
}
rootProject.name = "traceitx-android-views-sample"

include(":app")
