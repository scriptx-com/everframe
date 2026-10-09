// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins { alias(libs.plugins.android.application); alias(libs.plugins.kotlin.android) }
val proofResources = layout.buildDirectory.dir("generated/proof-resources")
val copyProofCa by tasks.registering(Copy::class) {
    from(providers.gradleProperty("nativeProofCa")); into(proofResources.map { it.dir("raw") }); rename { "proof_ca.pem" }
    doFirst { check(providers.gradleProperty("nativeProofCa").isPresent) { "Supply the local acceptance CA with -PnativeProofCa" } }
}
android {
    namespace = "dev.everframe.releaseproof"
    compileSdk = 35; ndkVersion = "29.0.14206865"
    defaultConfig {
        applicationId = "dev.everframe.releaseproof"; minSdk = 26; targetSdk = 35
        versionCode = providers.gradleProperty("nativeProofVersion").getOrElse("1").toInt(); versionName = "native-release-$versionCode"
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild { cmake { cppFlags += listOf("-O2", "-g", "-fno-omit-frame-pointer") } }
    }
    sourceSets.getByName("main").res.srcDir(proofResources)
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    // nativeProofLegacyPackaging=false keeps AGP's default, unextracted libraries for the negative control.
    packaging { jniLibs { if (providers.gradleProperty("nativeProofLegacyPackaging").getOrElse("true") == "true") useLegacyPackaging = true; keepDebugSymbols += "**/*.so" } }
    buildTypes.getByName("release") {
        isDebuggable = false; isMinifyEnabled = true; signingConfig = signingConfigs.getByName("debug")
        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
androidComponents.finalizeDsl { it.defaultConfig.minSdk = 26 }
tasks.named("preBuild") { dependsOn(copyProofCa) }
dependencies { implementation(project(":everframe-core")); if (providers.gradleProperty("nativeProofModule").getOrElse("true") == "true") implementation(project(":everframe-native-crash")) }
