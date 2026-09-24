// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Compose sample app — consumes the Everframe SDK from mavenLocal, the same
// way the RN sample does. The `pnpm dev:example:android` / `pnpm dev:example:android-tv`
// dev-runners run `pnpm --filter @everframe/sdk-android run publish:maven-local`
// before the install, so the configured repository's `dev/everframe/*` tree always
// reflects the current SDK source.
//
// Why mavenLocal instead of Gradle composite-build:
//   The previous revision used `includeBuild("../../packages/sdk-android/android")`
//   for hot-reload during SDK dev. That works while all three samples (this
//   one, android-views, and the SDK itself) share a single AGP / Gradle
//   version. As soon as the RN sample showed up with Expo SDK 56's AGP
//   8.12.0, composite-build failed the AgpVersionCompatibilityRule against
//   the SDK's AGP 8.7.2. To keep the dev flow uniform across all sample
//   apps, every host now consumes via mavenLocal — the SDK builds in its
//   own AGP universe, publishes AARs, and each host downloads them like
//   any external integrator would.
//
//   The stale-AAR trap that the prior revision's comments warned about
//   (a fix landing in source but the sample still serving an old AAR
//   from `~/.m2/`) is closed by always running `publish:maven-local`
//   immediately before the install — the AAR is never older than the
//   source.

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

rootProject.name = "everframe-android-compose-sample"

include(":app")
