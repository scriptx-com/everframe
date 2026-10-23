// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Qualification-only host for real-device quick capture and device linking. Included only with
// -PquickCaptureQualification=true; never published.
plugins { alias(libs.plugins.android.application); alias(libs.plugins.kotlin.android) }
android {
    namespace = "dev.everframe.qualification.quickcapture"
    compileSdk = 35
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "dev.everframe.qualification.quickcapture"; minSdk = 24; targetSdk = 35
        versionCode = 1; versionName = "quick-capture-1"
        // A synthetic key from your local platform; never a production key. Never logged.
        val key = providers.gradleProperty("quickCaptureHost.sdkKey").orNull ?: ""
        buildConfigField("String", "HOST_SDK_KEY", "\"${key.replace("\\", "").replace("\"", "")}\"")
        // -PquickCaptureHost.releaseMode=true starts the SDK with `debugBuild = false`, so the debug host (which
        // still reaches the local platform) follows the release-build rules of real-device quick capture.
        val releaseMode = providers.gradleProperty("quickCaptureHost.releaseMode").orNull == "true"
        buildConfigField("Boolean", "HOST_DEBUG_BUILD", if (releaseMode) "Boolean.FALSE" else "null")
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
// Debug only: the debug SDK takes its ingest endpoint from EVERFRAME_DEV_INGEST_URL at build time.
// The documented integration: core plus reporter-ui (which also supplies the foreground Activity).
dependencies {
    implementation(project(":everframe-core"))
    implementation(project(":everframe-reporter-ui"))
    // TV spike only (SpikeActivity): the Media3 version the SDK's :everframe-media3 module builds against.
    implementation("androidx.media3:media3-exoplayer:${libs.versions.media3.get()}")
    implementation("androidx.media3:media3-ui:${libs.versions.media3.get()}")
}
