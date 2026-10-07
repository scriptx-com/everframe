// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "dev.everframe.stallproof"
    compileSdk = 35
    defaultConfig {
        applicationId = providers.gradleProperty("proofApplicationId").getOrElse("dev.everframe.stallproof")
        minSdk = 24; targetSdk = 35
        versionCode = 1; versionName = "stall-proof-1"
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            // Installable qualification build. Shipping libraries retain their normal Release settings.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation("dev.everframe:core:${providers.gradleProperty("everframeVersion").get()}")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
