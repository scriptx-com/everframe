// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.1.0" apply false
    id("org.jetbrains.kotlin.android") version "2.4.0" apply false
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven {
            url = uri(System.getenv("MAVEN_LOCAL_REPOSITORY")
                ?: error("MAVEN_LOCAL_REPOSITORY must point at a disposable dry-run repository"))
            content { includeGroup("dev.everframe") }
        }
        maven { url = uri("https://storage.googleapis.com/download.flutter.io") }
        google()
        mavenCentral()
    }
}

include(":app")
