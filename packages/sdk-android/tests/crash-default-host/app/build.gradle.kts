// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins { alias(libs.plugins.android.application); alias(libs.plugins.kotlin.android) }
val proofResources = layout.buildDirectory.dir("generated/proof-resources")
val copyProofCa by tasks.registering(Copy::class) {
    from(providers.gradleProperty("crashDefaultCa")); into(proofResources.map { it.dir("raw") }); rename { "proof_ca.pem" }
    doFirst { check(providers.gradleProperty("crashDefaultCa").isPresent) { "Supply the local acceptance CA with -PcrashDefaultCa" } }
}
android {
    namespace = "dev.everframe.crashdefault"
    compileSdk = 35; ndkVersion = "29.0.14206865"
    buildFeatures { buildConfig = true }
    defaultConfig {
        applicationId = "dev.everframe.crashdefault"; minSdk = 24; targetSdk = 35
        versionCode = 1; versionName = "crash-default-1"
        val key = providers.gradleProperty("crashDefaultSdkKey").orNull ?: ""
        require(Regex("evf_live_[0-9A-Za-z]{32}").matches(key)) { "Supply a synthetic local key with -PcrashDefaultSdkKey" }
        buildConfigField("String", "PROOF_SDK_KEY", "\"$key\"")
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild { cmake { cppFlags += listOf("-O2", "-g") } }
    }
    sourceSets.getByName("main").res.srcDir(proofResources)
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    buildTypes.getByName("release") {
        isDebuggable = false; isMinifyEnabled = true; signingConfig = signingConfigs.getByName("debug")
        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
tasks.named("preBuild") { dependsOn(copyProofCa) }
// Core only: the default path must not need the optional native-crash module on API 30+.
dependencies { implementation(project(":everframe-core")) }
