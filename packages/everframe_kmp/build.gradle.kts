// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import java.util.Properties

plugins {
    kotlin("multiplatform") version "2.4.20"
    id("com.android.kotlin.multiplatform.library") version "9.1.0"
    id("org.jetbrains.dokka") version "2.2.0"
    `maven-publish`
    signing
}

group = "dev.everframe"
val mobileReleaseVersion = providers.gradleProperty("everframeVersion").orElse(provider {
    val androidProperties = Properties()
    file("../sdk-android/android/gradle.properties").inputStream().use(androidProperties::load)
    androidProperties.getProperty("everframeVersion")
        ?: error("everframeVersion is missing from the Android release properties")
}).get()
version = mobileReleaseVersion

val everframeNativeVersion = providers.gradleProperty("everframeNativeVersion")
    .orElse(mobileReleaseVersion)

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
    js {
        browser()
        nodejs()
    }

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

// The Swift adapter is host source, so include it with the published iOS sources.
listOf("sourcesJar", "iosArm64SourcesJar", "iosSimulatorArm64SourcesJar").forEach { taskName ->
    tasks.named<org.gradle.jvm.tasks.Jar>(taskName) {
        from("ios/EverframeSwiftDriver.swift") { into("ios") }
    }
}

publishing {
    repositories {
        maven {
            name = "CentralBundle"
            url = layout.buildDirectory.dir("central-bundle/repository").get().asFile.toURI()
        }
    }
    publications.withType<MavenPublication>().configureEach {
        val publicationName = name
        val dokkaJavadocJar = tasks.register<Jar>("${publicationName}JavadocJar") {
            dependsOn("dokkaGeneratePublicationHtml")
            from(tasks.named("dokkaGeneratePublicationHtml").map { it.outputs.files })
            archiveBaseName.set("everframe-kmp-$publicationName")
            archiveClassifier.set("javadoc")
        }
        artifact(dokkaJavadocJar)
        pom {
            name.set("Everframe Kotlin Multiplatform bridge")
            description.set("Kotlin Multiplatform bridge for Everframe reporting on Android, iOS, and web.")
            url.set("https://everframe.dev")
            licenses {
                license {
                    name.set("MIT")
                    url.set("https://opensource.org/license/mit")
                }
            }
            developers {
                developer {
                    id.set("scriptx")
                    name.set("ScriptX")
                    email.set("engineering@scriptx.com")
                }
            }
            scm {
                connection.set("scm:git:https://github.com/scriptx-com/everframe.git")
                developerConnection.set("scm:git:ssh://git@github.com/scriptx-com/everframe.git")
                url.set("https://github.com/scriptx-com/everframe")
            }
        }
    }
}

signing {
    val signingKey = System.getenv("SIGNING_KEY")
    val signingPassword = System.getenv("SIGNING_PASSWORD")
    if (!signingKey.isNullOrBlank() && !signingPassword.isNullOrBlank()) {
        useInMemoryPgpKeys(signingKey, signingPassword)
        sign(publishing.publications)
    }
}

val cleanCentralBundleRepository = tasks.register<Delete>("cleanCentralBundleRepository") {
    delete(layout.buildDirectory.dir("central-bundle/repository"))
}

tasks.matching {
    it.name.startsWith("publish") &&
        it.name.endsWith("PublicationToCentralBundleRepository")
}.configureEach {
    dependsOn(cleanCentralBundleRepository)
}

tasks.register<Zip>("centralPortalBundle") {
    group = "publishing"
    dependsOn("publishAllPublicationsToCentralBundleRepository")
    from(layout.buildDirectory.dir("central-bundle/repository"))
    destinationDirectory.set(layout.buildDirectory.dir("central-bundle"))
    archiveFileName.set("everframe-kmp-${project.version}.zip")
}
