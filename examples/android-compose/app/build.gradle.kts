// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TraceItX Compose sample app (Plan 05-08).
//
// Single phone/tablet APK (the layout adapts via UI-SPEC tablet breakpoints).
// The Android TV flavor was retired alongside the on-device :traceitx-tv
// modal Activity — TV reporting now goes through the phone companion flow,
// which doesn't need a dedicated leanback sample variant.
//
// Dependencies flow through the composite build at ../../android (see
// settings.gradle.kts) so local SDK changes are picked up without a publish
// step. The `com.traceitx:*` coordinates are also resolvable from mavenLocal
// after `./gradlew :publishAllToMavenLocal` from the SDK root, matching the
// customer-consumption shape exactly.

import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Read host-specific properties from local.properties (gitignored). Gradle
// itself only auto-loads `sdk.dir` / `ndk.dir` from this file; custom keys
// must be parsed by hand. Source of truth: repo-root .env →
// scripts/gen-local-properties.sh writes traceitx.sample.sdkKey here.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.example.composesample"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.composesample"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        // Sample dev SDK key loaded from local.properties; never committed.
        // local.properties is materialized from repo-root .env via
        // `pnpm gen-android-config` (scripts/gen-local-properties.sh).
        // Falls back to a -P flag (`./gradlew … -Ptraceitx.sample.sdkKey=…`) and
        // finally to the throwaway dev key if nothing else is set.
        val sampleSdkKey = localProps.getProperty("traceitx.sample.sdkKey")
            ?: (project.findProperty("traceitx.sample.sdkKey") as String?)
            ?: "txx_dev_sample_throwaway"
        buildConfigField("String", "TRACEITX_SDK_KEY", "\"$sampleSdkKey\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        getByName("debug") { isMinifyEnabled = false }
        getByName("release") {
            // Plan 05-08 R8 string-survival gate runs against this minified APK.
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // Sign release with debug keystore so `./gradlew :app:assembleRelease`
            // produces an APK without needing a real keystore (sample-only;
            // never ship to Play with this signature).
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    // Plan 05-08 deviation: AGP 8.7's lintVital pass crashes inside
    // NonNullableMutableLiveDataDetector with IncompatibleClassChangeError
    // when run against Kotlin 2.1's newer UAST shape. We don't ship lint
    // failures for the sample apps; R8 + assembleRelease already exercise
    // the customer-relevant codepaths the plan's gates check for.
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

// TraceItX SDK version, READ FROM THE SDK rather than pinned here.
//
// These coordinates were hardcoded to `1.2.0-LOCAL2` while the SDK publishes
// whatever `packages/sdk-android/android/gradle.properties:traceitxVersion`
// says (0.5.0 at time of writing). The mismatch was invisible to anyone who
// had once published 1.2.0-LOCAL2 into their own ~/.m2 — it resolves from the
// local cache forever after — and fatal on a clean machine, which is exactly
// how CI's r8-string-survival job failed:
//
//   Could not find com.traceitx:core:1.2.0-LOCAL2
//
// right after the preceding step had published 0.5.0 to mavenLocal. Reading
// the SDK's own property means the sample cannot drift from the artifacts the
// publish step actually produces. `-PtraceitxVersion=X.Y.Z` still overrides,
// matching the SDK build's own convention.
val traceitxVersion: String =
    (project.findProperty("traceitxVersion") as String?)
        ?: rootProject.file("../../packages/sdk-android/android/gradle.properties")
            .takeIf { it.exists() }
            ?.readLines()
            ?.firstNotNullOfOrNull { line ->
                line.trim().removePrefix("traceitxVersion=").takeIf { it != line.trim() }
            }
        ?: error(
            "Could not determine traceitxVersion: pass -PtraceitxVersion=X.Y.Z, or ensure " +
                "packages/sdk-android/android/gradle.properties declares it.",
        )

dependencies {
    // Plan 05-08 — TraceItX SDK Maven coordinates (resolved from mavenLocal
    // after `publishAllToMavenLocal`; via Maven Central in customer setups).
    implementation("com.traceitx:core:$traceitxVersion")
    implementation("com.traceitx:reporter-ui:$traceitxVersion")

    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")

    // OkHttp client demo for addTraceItXInterceptor()
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Session Vitals playback tracking (spec 2026-09-05)
    implementation("com.traceitx:media3:$traceitxVersion")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
}
