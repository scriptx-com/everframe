// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
group = "dev.everframe.flutter"
version = "1.0.0"

buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath("com.android.tools.build:gradle:9.1.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.0")
    }
}

allprojects {
    repositories {
        val localRepo = System.getenv("MAVEN_LOCAL_REPOSITORY")
        if (!localRepo.isNullOrBlank()) {
            maven { url = uri(localRepo) }
        }
        google()
        mavenCentral()
    }
}

plugins {
    id("com.android.library")
}

android {
    namespace = "dev.everframe.flutter"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets.getByName("main").java.srcDirs("src/main/kotlin")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

val everframeNativeVersion = providers.gradleProperty("everframeNativeVersion")
    .orElse("[1.0.0,1.1.0)")

dependencies {
    implementation("dev.everframe:core") {
        version { strictly(everframeNativeVersion.get()) }
    }
    implementation("dev.everframe:reporter-ui") {
        version { strictly(everframeNativeVersion.get()) }
    }
}
