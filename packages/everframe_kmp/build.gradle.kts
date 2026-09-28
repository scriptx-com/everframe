// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins {
    kotlin("multiplatform") version "2.4.20"
    id("com.android.library") version "8.7.2"
}

kotlin {
    androidTarget()
    iosArm64()
    iosSimulatorArm64()
    jvm()

    targets.withType<org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget>().configureEach {
        binaries.framework { baseName = "EverframeKmp" }
    }

    sourceSets {
        commonTest.dependencies { implementation(kotlin("test")) }
        androidMain.dependencies {
            implementation("dev.everframe:core:0.9.0-DEV")
            implementation("dev.everframe:reporter-ui:0.9.0-DEV")
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
        }
    }
}

android {
    namespace = "dev.everframe.kmp"
    compileSdk = 35
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
