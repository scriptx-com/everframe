// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Copy into the application build.gradle.kts and set paths for your exact variant.
// CI calls: ./gradlew :app:verifyReleaseNativeSymbols
// Token and app ID come from EVERFRAME_API_TOKEN and EVERFRAME_APP_ID in CI.
// This explicit task does not add uploads to an ordinary assembleRelease build.
val verifyReleaseNativeSymbols by tasks.registering(Exec::class) {
    dependsOn("assembleRelease")
    val symbolDirectory = layout.projectDirectory.dir("symbols/release")
    // Explicit shipped stripped files, one per module and ABI. This example
    // covers only these two files; list every library/ABI you intend to ship.
    val shippedLibraries = listOf(
        layout.projectDirectory.file("shipped/release/arm64-v8a/libapp.so"),
        layout.projectDirectory.file("shipped/release/armeabi-v7a/libapp.so"),
    )
    commandLine(
        listOf(
            "bash",
            rootProject.file("ci/upload-android-symbols.sh").absolutePath,
            symbolDirectory.asFile.absolutePath,
        ) + shippedLibraries.map { it.asFile.absolutePath }
    )
    // Exec runs every invocation and propagates any failed upload to the CI gate.
    // Keep native binaries/symbols available until this task has completed.
}
