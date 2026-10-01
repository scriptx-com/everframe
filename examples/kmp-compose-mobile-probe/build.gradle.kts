// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins {
    kotlin("multiplatform") version "2.4.20"
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20"
    id("org.jetbrains.compose") version "1.11.1"
    id("com.android.library") version "9.1.0"
    id("com.android.kotlin.multiplatform.library") version "9.1.0" apply false
}

kotlin {
    androidTarget()
    iosArm64()
    iosSimulatorArm64()
    targets.withType<org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget>().configureEach {
        binaries.framework {
            baseName = "KmpComposeProbe"
            // Compose's cached iOS library carries a stale Xcode 26.4 search path on this host.
            linkerOpts("-L/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/iphonesimulator")
        }
    }
    sourceSets {
        commonMain.dependencies {
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.material)
        }
    }
}

android {
    namespace = "dev.everframe.composeprobe"
    // Stable Compose dependencies use Android 16 APIs; device support stays at API 24.
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
