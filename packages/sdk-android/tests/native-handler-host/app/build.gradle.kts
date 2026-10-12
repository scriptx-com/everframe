// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins { id("com.android.application") }
android {
  namespace = "dev.everframe.qualification"
  compileSdk = 35
  defaultConfig {
    applicationId = providers.gradleProperty("proofApplicationId").getOrElse("dev.everframe.qualification")
    minSdk = 26; targetSdk = 35; versionCode = 1; versionName = "native-handler-qualification-1"
  }
  sourceSets.getByName("main").jniLibs.srcDir(providers.gradleProperty("qualificationJniLibs").get())
  packaging { jniLibs { useLegacyPackaging = true; keepDebugSymbols += "**/*.so" } }
  buildTypes.getByName("release") {
    isDebuggable = false // Genuine Release app identity; readback is owned emulator instrumentation.
    isMinifyEnabled = true
    signingConfig = signingConfigs.getByName("debug")
    proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
  }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
}
