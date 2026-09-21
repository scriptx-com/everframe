// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Compose sample app — consumes the TraceItX SDK from mavenLocal, the same
// way the RN sample does. The `pnpm dev:example:android` / `pnpm dev:example:android-tv`
// dev-runners run `pnpm --filter @traceitx/sdk-android run publish:maven-local`
// before the install, so `~/.m2/repository/com/traceitx/traceitx-*` always
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
        // The `com.traceitx` Gradle plugin id (from :traceitx-gradle-plugin)
        // resolves from mavenLocal after publishAllToMavenLocal.
        mavenLocal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // mavenLocal FIRST, deliberately. `com.traceitx:core` is also published
        // to Maven Central at the same coordinates, and Gradle resolves from
        // the first repository that HAS the module — so with mavenLocal last,
        // a locally published AAR was silently ignored in favour of the last
        // RELEASED one whenever the two versions collided (they do today:
        // gradle.properties pins traceitxVersion=0.6.0 and 0.6.0 is on
        // Central). That made every local SDK change invisible here, and made
        // the `r8-string-survival` CI job gate the shipped artifact instead of
        // the branch under test — the job publishes to mavenLocal and then
        // built against Central anyway. Third-party deps are unaffected:
        // mavenLocal simply misses them and resolution falls through.
        mavenLocal()
        google()
        mavenCentral()
    }
}

rootProject.name = "traceitx-android-compose-sample"

include(":app")
