// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins {
    kotlin("multiplatform") version "2.4.20"
    id("com.android.kotlin.multiplatform.library") version "9.1.0"
}

val everframeNativeVersion = providers.gradleProperty("everframeNativeVersion")
    .orElse("[0.10.0,0.11.0)")

kotlin {
    android {
        namespace = "dev.everframe.kmp"
        compileSdk = 35
        minSdk = 24
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
    iosArm64()
    iosSimulatorArm64()
    jvm()

    targets.withType<org.jetbrains.kotlin.gradle.plugin.mpp.KotlinNativeTarget>().configureEach {
        binaries.framework { baseName = "EverframeKmp" }
    }

    sourceSets {
        commonTest.dependencies { implementation(kotlin("test")) }
        androidMain.dependencies {
            implementation("dev.everframe:core") {
                version { strictly(everframeNativeVersion.get()) }
            }
            implementation("dev.everframe:reporter-ui") {
                version { strictly(everframeNativeVersion.get()) }
            }
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
        }
    }
}
