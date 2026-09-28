// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins {
    id("com.android.application") version "8.7.2"
    id("com.android.library") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "2.4.20"
    id("org.jetbrains.kotlin.multiplatform") version "2.4.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20"
}

android {
    namespace = "dev.everframe.kmpprobe"
    compileSdk = 35
    defaultConfig {
        applicationId = "dev.everframe.kmpprobe"
        minSdk = 24
        targetSdk = 35
    }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
}

dependencies {
    implementation(project(":everframeKmp"))
    implementation("dev.everframe:core:0.9.0-DEV")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.compose.material3:material3")
}
