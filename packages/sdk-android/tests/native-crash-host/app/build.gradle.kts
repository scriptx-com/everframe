// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "dev.everframe.nativeproof"
    compileSdk = 35
    ndkVersion = "29.0.14033849"
    defaultConfig {
        applicationId = providers.gradleProperty("proofApplicationId").getOrElse("dev.everframe.nativeproof")
        minSdk = 24; targetSdk = 35
        versionCode = 1; versionName = "native-proof-1"
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64") }
        externalNativeBuild { cmake { cppFlags += listOf("-O2", "-g", "-fno-omit-frame-pointer", "-fno-optimize-sibling-calls") } }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            // Installable qualification build. Shipping libraries retain their normal Release settings.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    implementation("dev.everframe:core:${providers.gradleProperty("everframeVersion").get()}")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
