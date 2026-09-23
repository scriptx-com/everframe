// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe View XML sample app (Java consumer demo). Consumes the SDK
// from mavenLocal — matching the android-compose and react-native samples.
// `pnpm dev:example:android` re-publishes the SDK to `~/.m2/repository/com/everframe/`
// before the install, so the consumed AARs are never older than the
// current SDK source. See `examples/android-compose/settings.gradle.kts`
// for the full rationale.

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
        exclusiveContent {
            forRepository {
                maven {
                    name = "everframeLocal"
                    url = uri(System.getenv("MAVEN_LOCAL_REPOSITORY")
                        ?: error("MAVEN_LOCAL_REPOSITORY must point at the disposable Everframe repository"))
                }
            }
            filter { includeGroup("dev.everframe") }
        }
        google()
        mavenCentral()
    }
}
rootProject.name = "everframe-android-views-sample"

include(":app")
