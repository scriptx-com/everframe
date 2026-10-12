// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins { alias(libs.plugins.android.application);alias(libs.plugins.kotlin.android) }
android {
    namespace="dev.everframe.qualification"
    compileSdk=35
    defaultConfig { applicationId=providers.gradleProperty("proofApplicationId").getOrElse("dev.everframe.nativequalification.importproof");minSdk=26;targetSdk=35;versionCode=1;versionName="durable-native-import-1" }
    sourceSets.getByName("main").jniLibs.srcDir(providers.gradleProperty("qualificationJniLibs").get())
    packaging { jniLibs { useLegacyPackaging=true;keepDebugSymbols += "**/*.so" } }
    buildTypes.create("qualification") {
        initWith(buildTypes.getByName("release"));isDebuggable=false;isMinifyEnabled=true
        signingConfig=signingConfigs.getByName("debug")
        matchingFallbacks += "debug" // Internal importer is deliberately not bound to a published SDK API.
        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"),"proguard-rules.pro")
    }
    compileOptions { sourceCompatibility=JavaVersion.VERSION_17;targetCompatibility=JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget="17" }
}
androidComponents.finalizeDsl { it.defaultConfig.minSdk=26 }
dependencies { implementation(project(":everframe-core"));implementation(libs.coroutines.android);implementation(libs.serialization.json) }
