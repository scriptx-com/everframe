// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
plugins {
    alias(libs.plugins.android.library)
    `maven-publish`
    signing
}
// This module is Java-only, so Dokka cannot infer roots from the Kotlin plugin.
extensions.configure<org.jetbrains.dokka.gradle.DokkaExtension> {
    dokkaSourceSets.register("main") {
        sourceRoots.from(file("src/main/java"))
    }
}
val nativeWorkspace = providers.gradleProperty("everframeNativeBuildDir")
    .map { file(it) }.orElse(layout.projectDirectory.dir("../../native/build").asFile)
val nativeAbis = providers.gradleProperty("everframeNativeAbis").orElse("all")
android {
    namespace = "dev.everframe.nativecrash"
    defaultConfig { consumerProguardFiles("consumer-rules.pro") }
    sourceSets.getByName("main").jniLibs.srcDir(nativeWorkspace.map { it.resolve("jniLibs") })
    packaging { jniLibs { useLegacyPackaging = true; keepDebugSymbols += "**/libeverframe_native_*.so" } }
}
val verifyNativeArtifacts by tasks.registering(Exec::class) {
    commandLine("python3", file("../../native/build.py"), "--workspace", nativeWorkspace.get(),
        "--abi", nativeAbis.get(), "--verify-only")
}
tasks.matching { it.name.contains("JniLibFolders") }.configureEach { dependsOn(verifyNativeArtifacts) }
// Partial-ABI local acceptance builds must never be published as the complete library.
tasks.withType<org.gradle.api.publish.maven.tasks.PublishToMavenRepository>().configureEach {
    doFirst { check(nativeAbis.get() == "all") { "Publication requires all four verified native ABIs" } }
}
tasks.withType<org.gradle.api.publish.maven.tasks.PublishToMavenLocal>().configureEach {
    doFirst { check(nativeAbis.get() == "all") { "Publication requires all four verified native ABIs" } }
}
afterEvaluate {
    publishing.publications.create<MavenPublication>("release") {
        from(components[rootProject.extra["everframePublishVariant"] as String])
        groupId = "dev.everframe"; artifactId = "native-crash"; version = project.version.toString()
        pom {
            name.set("Everframe Android native crash capture")
            description.set("Optional encrypted native fault recovery for supported Android applications.")
            url.set("https://everframe.dev")
            licenses { license { name.set("MIT"); url.set("https://opensource.org/license/mit") } }
            developers { developer { id.set("scriptx"); name.set("ScriptX"); email.set("engineering@scriptx.com") } }
            scm { url.set("https://github.com/scriptx-com/everframe"); connection.set("scm:git:https://github.com/scriptx-com/everframe.git") }
            issueManagement { system.set("GitHub"); url.set("https://github.com/scriptx-com/everframe/issues") }
        }
    }
    signing {
        val key = System.getenv("SIGNING_KEY") ?: project.findProperty("signing.key")?.toString()
        val password = System.getenv("SIGNING_PASSWORD") ?: project.findProperty("signing.password")?.toString()
        if (key != null && password != null) { useInMemoryPgpKeys(key, password); sign(publishing.publications["release"]) }
    }
}
