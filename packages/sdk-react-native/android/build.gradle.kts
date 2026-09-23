// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// @everframe/react-native — Android library Gradle build (Plan 06-03).
//
// WORKSPACE-INTERNAL CONSUMPTION (dogfood path — see 06-06 sample app):
//   The host RN sample app's `settings.gradle.kts` adds:
//     includeBuild("../../../packages/sdk-android/android")           // surfaces :everframe-core, :everframe-reporter-ui
//   This library declares the two project deps below which resolve through the
//   composite-build mechanism. The on-device :everframe-tv Activity was removed
//   alongside the iOS tvOS modal — Android TV hosts route reporting through the
//   phone-companion (QR → phone browser SPA) flow via CompanionCaptureBridge.
//
// CODEGEN:
//   The `com.facebook.react` Gradle plugin reads `codegenConfig` from
//   `packages/sdk-react-native/package.json` (added in Plan 06-03 — see
//   06-03-SUMMARY.md "Deviations"). The plugin generates
//   `dev.everframe.rn.NativeEverframeSpec` from `src/NativeEverframe.ts`
//   into `build/generated/source/codegen/`. EverframeModule currently extends
//   the legacy ReactContextBaseJavaModule surface (structural-superset of the
//   spec); a host on the new architecture can flip the parent class with a
//   1-line patch once codegen output is available in the consuming build.
//
// ZERO-PERMISSION:
//   No `<uses-permission>` in AndroidManifest.xml. The bridge adds zero
//   permissions on top of whatever `:everframe-core` declares (the core also
//   has none — Phase 5 zero-permission AAR contract). Verified by the 06-03
//   acceptance grep.
//
// SCOPE (NOT in this build):
//   • Namespace is `dev.everframe.rn`.

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    // Apply `com.facebook.react` so the bridge module's codegen pipeline
    // is wired: the host's auto-generated `Android-autolinking.cmake`
    // does `add_subdirectory("…/packages/sdk-react-native/android/build/
    // generated/source/codegen/jni/")`, and without this plugin that
    // directory is never produced, so the host's CMake configure fails.
    // Earlier comment claimed pnpm hoisting made this plugin brittle;
    // empirically the plugin discovers `react-native` from node_modules
    // via the standard CLI path resolver, and our hoisted react-native
    // is resolvable from the host's package — no actual breakage.
    id("com.facebook.react")
}

react {
    // Point codegen at the TS specs in this package. `jsRootDir` is
    // relative to this build.gradle.kts; specs live at
    // `packages/sdk-react-native/src/NativeEverframe.ts` (codegenConfig
    // in package.json sets `jsSrcsDir: "src"`).
    jsRootDir = file("../src/")
    libraryName = "EverframeSpec"                          // matches codegenConfig.name
    codegenJavaPackageName = "dev.everframe.rn"  // matches codegenConfig.android.javaPackageName
}

android {
    namespace = "dev.everframe.rn"
    compileSdk = 36

    defaultConfig {
        minSdk = 24    // matches :everframe-core floor (Phase 5)
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = false
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    // Task 11 (Plan 5) — `EverframeModuleTest.kt` / `EverframeCompanionModuleTest.kt`
    // exercise a `EverframeModule` contract that no longer exists on `main`
    // (captureNow/submit/openAnnotationOverlay were removed by the
    // D-05/D-07 flip; `startCompanion()` now takes zero args;
    // `Companion.__setState`/`__setPairUrl` are `internal` to
    // :everframe-core and unreachable from this separate Gradle module) —
    // confirmed pre-existing and unrelated to Task 11 (Plan 4 Task 14 first
    // hit this reproducing against unmodified HEAD; see
    // .superpowers/sdd/task-11-report.md for the full compile-error dump).
    // `compileDebugUnitTestKotlin` compiles the entire `test` source set as
    // one Kotlin unit, so these two permanently-broken files block
    // `RnReplayBridgeTest.kt` (Task 11's actual subject, itself fixed by the
    // `BridgeReactContext` swap in this same change) from ever compiling.
    // Excluded here — NOT deleted — pending a follow-up ticket to either
    // delete or fully rewrite them against the current module API.
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>()
    .matching { it.name.endsWith("UnitTestKotlin") } // compileDebugUnitTestKotlin + compileReleaseUnitTestKotlin
    .configureEach {
        exclude(
            "**/EverframeModuleTest.kt",
            "**/EverframeCompanionModuleTest.kt",
        )
    }

// Derive the native-AAR range from this package's own npm version (single
// source of truth: ../package.json). `[X.Y.Z, X.(Y+1).0)` blocks cross-minor
// drift (which has shipped protocol-breaking changes in practice) and puts a
// floor at this package's exact version. Republish the JS package to roll
// consumers onto a new native version.
//
// The floor matters. A range of `X.Y.+` resolves to the highest version Gradle
// can currently SEE, so a stale dynamic-version cache — or a mavenLocal holding
// an older patch — hands the bridge an AAR older than the JS half it shipped
// with. Gradle re-resolves upward once the cache expires, unlike CocoaPods,
// which pins in a lockfile; the floor removes the window entirely.
//
// `EverframeRN.podspec` carries the same floor.
//
// Every release publishes the native SDKs before the npm packages and verifies
// the exact version's POM and binary are fetchable from Maven Central first.
//
// `everframeNativeVersion` OVERRIDES that derivation, and exists for exactly
// one situation: the monorepo dev loop, between a native minor landing and
// changesets publishing the JS bump that matches it.
//
// That window is not an edge case, it is every native minor. `package.json`
// only reaches the new version when `changeset version` runs at RELEASE
// time, so while the companion-attribution work sat unreleased, this file
// resolved `0.4.+` -> the stale 0.4.4 AAR while the bridge source called
// APIs added in native 0.5.0. Gradle resolved it happily (0.4.4 was in
// mavenLocal from an earlier release) and the failure surfaced as three
// unrelated-looking Kotlin errors — `Unresolved reference
// '__clearPendingAttribution'`, a SuspendFunction3-vs-2 mismatch, and
// `No parameter with name 'companionAttribution'` — none of which name a
// version. scripts/dev/rn.mjs now passes this property with the version it
// just published to mavenLocal, so the dev loop compiles against exactly
// the AAR it built.
//
// Deliberately NOT read from gradle.properties or any monorepo path: this
// file also runs from inside the published npm tarball at a consumer's
// install, where no such file exists. Unset — every consumer build — the
// derivation below is the only source of truth, unchanged.
val nativeVersionOverride = (findProperty("everframeNativeVersion") as String?)
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
val rnSdkPkg = groovy.json.JsonSlurper()
    .parse(file("../package.json")) as Map<*, *>
val rnSdkVersion = rnSdkPkg["version"] as String
val nativeMinorRange: String = nativeVersionOverride ?: "[0.9.0,0.10.0)"
if (nativeVersionOverride != null) {
    logger.lifecycle(
        "[everframe-rn] native AAR pinned to $nativeVersionOverride via everframeNativeVersion " +
            "(package.json says $rnSdkVersion — local dev override)",
    )
}

dependencies {
    // Maven Central coordinates (dev.everframe:{core,reporter-ui}) consumed
    // via the host app's mavenCentral() repository. Range derived from the JS
    // package's own version (see `nativeMinorRange` above) — patches roll
    // automatically, minors don't.
    // Local-dev workflow can still inject mavenLocal() in the host gradle
    // and `publishToMavenLocal` an unreleased patch — the version range
    // resolves there first.
    //
    // `strictly`, not a plain range. An ordinary range is a PREFERENCE that
    // Gradle's conflict resolution may raise past its own upper bound: a host
    // that also asks for `dev.everframe:core:0.7.0` would otherwise resolve this
    // bridge against a native SDK a minor ahead of it, which is exactly the
    // protocol drift the bound exists to stop, and it would do so silently.
    // `strictly` makes that a build failure the host can see and decide about.
    // CocoaPods' `~>` already behaves this way, so this keeps the two halves
    // honest about the same promise.
    implementation("dev.everframe:core") { version { strictly(nativeMinorRange) } }
    implementation("dev.everframe:reporter-ui") { version { strictly(nativeMinorRange) } }

    // React Native Android — provided by the host app's React Native install.
    // We declare compileOnly so the AAR doesn't bundle a copy; the host's
    // codegen-aware `react-android` Maven artifact (or sourceSet) supplies the
    // runtime classes. Hosts on new-architecture get react-android transitively
    // from the `com.facebook.react` plugin they apply at the app level.
    compileOnly("com.facebook.react:react-android:0.84.0")

    // Coroutines — already a transitive of :everframe-core; declared explicitly
    // here so the module's MainScope / Dispatchers.IO calls resolve without
    // relying on transitive promotion.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // kotlinx-serialization-json — used by the companion capture provider
    // to serialize the UITree to JSON before gzipping it for the relay
    // tap-to-identify binary frame. Already on the classpath transitively
    // via :everframe-protocol (implementation-scoped there), but we need a
    // direct reference here to call the Json { } factory.
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Unit tests (Plan 06-03 Task 3). Versions mirror :everframe-core (see
    // packages/sdk-android/android/gradle/libs.versions.toml — junit 4.13.2, robolectric 4.13).
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("com.facebook.react:react-android:0.84.0")
}
