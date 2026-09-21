// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TraceItX View XML sample app (Plan 05-08).
//
// Demonstrates:
//   • Java MainActivity calling TraceItX.start(...)
//   • TXSensitiveView wrapping a password EditText in login_screen.xml
//   • app:tx_sensitive="true" custom XML attribute (resolved by
//     SensitiveLayoutInflaterFactory; PRIV-03 redaction)
//   • android:inputType="textPassword" auto-detect path (Plan 03)
//   • TraceItX.report.openAsync(Callback<ReportResult>) — Java callback shim
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Host-specific local.properties (gitignored). Gradle auto-loads only
// sdk.dir/ndk.dir; custom keys must be parsed by hand. Source of truth:
// repo-root .env → scripts/gen-local-properties.sh writes traceitx.sample.sdkKey.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.example.viewssample"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.viewssample"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        val sampleSdkKey = localProps.getProperty("traceitx.sample.sdkKey")
            ?: (project.findProperty("traceitx.sample.sdkKey") as String?)
            ?: "txx_dev_sample_throwaway"
        buildConfigField("String", "TRACEITX_SDK_KEY", "\"$sampleSdkKey\"")
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    buildTypes {
        getByName("debug") { isMinifyEnabled = false }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("com.traceitx:core:1.2.0-SNAPSHOT")
    implementation("com.traceitx:reporter-ui:1.2.0-SNAPSHOT")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    // Plan 05.1-02: PresentingObserver collects TraceItX.report.isPresenting on
    // the Activity's lifecycleScope (per plan-checker W2 — never GlobalScope).
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Plan 06.2-08: ZXing QR rendering — lives in the EXAMPLE app only
    // (T-06.2-08-04 mitigation: SDK AAR stays QR-library-free). 4.3.0 pulls
    // the zxing core jar transitively, which already provides BitMatrix +
    // QRCodeWriter. The "embedded" portion ships scanning UI we ignore here.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
