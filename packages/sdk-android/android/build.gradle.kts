// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Root Gradle build for the Everframe Android SDK (Plan 05-01 + 05-08).
// Plugins are declared at the root with `apply false` so each subproject opts in.
//
// Plan 05-08: Maven publish coordination — every Android library subproject
// auto-applies `maven-publish` + a release `MavenPublication`. Customers consume via
// `dev.everframe:<module>:<version>` from Maven Central.

plugins {
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.kotlin.compose) apply false
    id("org.jetbrains.dokka-javadoc") version "2.2.0" apply false
}

// Single publish version for every module. Source of truth is
// `gradle.properties:everframeVersion`; override per-build with
// `-PeverframeVersion=X.Y.Z`. The 0.0.0-LOCAL default only fires if both are
// missing — a deliberately-invalid SemVer so an unconfigured environment
// produces an obviously-broken artifact instead of a silent SNAPSHOT push.
// --- Local-dev publishing gate ------------------------------------------
// `-PeverframeDevLocal=true` is the ONE switch that distinguishes "I am
// dogfooding against my laptop" from "this artifact is going to consumers".
// It changes two things together, and they must move together:
//
//   1. the published VARIANT flips release -> debug, and
//   2. the version gains a `-DEV` suffix.
//
// (1) is the point. `everframe-core`'s release variant hardcodes
// INGEST_URL = https://everframe.dev and deliberately refuses to read
// EVERFRAME_DEV_INGEST_URL — an env-var fallback there once let a maintainer
// publish an AAR pointing at their own laptop to Maven Central, which cannot
// be rewritten. Only the DEBUG variant honours the override. Publishing
// release-only therefore made local Android dogfooding impossible: every
// sample app posted to production with a local dev key and the reports simply
// vanished, with no error anywhere and no request reaching local ingest.
//
// (2) is what keeps that convenience from becoming the old hazard. A `-DEV`
// artifact cannot be mistaken for a release: it never overwrites the real
// version in ~/.m2, consumers must ask for it by name, and a `-DEV` string
// escaping into a release POM is glaring in review.
//
// The flag swaps which component the SINGLE publication is built from; it
// never adds a second publication. Central bundles reject dev-local variants.
val everframeDevLocal: Boolean =
    (project.findProperty("everframeDevLocal") as String?)?.toBoolean() ?: false
val everframePublishVariant: String = if (everframeDevLocal) "debug" else "release"
val everframeVersionResolved: String =
    ((project.findProperty("everframeVersion") as String?) ?: "0.0.0-LOCAL")
        .let { if (everframeDevLocal) "$it-DEV" else it }
allprojects {
    group = "dev.everframe"
    version = everframeVersionResolved
    // Read by each module's MavenPublication. Kept here rather than recomputed
    // per module so the variant and the version can never disagree.
    extra["everframePublishVariant"] = everframePublishVariant
}
if (everframeDevLocal) {
    logger.lifecycle(
        "[everframe] DEV-LOCAL publish: variant=$everframePublishVariant version=$everframeVersionResolved " +
            "(ingest URL comes from EVERFRAME_DEV_INGEST_URL; NOT publishable to Maven Central)",
    )
    gradle.taskGraph.whenReady {
        val bundleTasks = allTasks.filter { it.name.contains("CentralBundle", ignoreCase = true) }
        if (bundleTasks.isNotEmpty()) {
            error(
                "Refusing to include a dev-local build in a Central Portal bundle.\n" +
                    "  -PeverframeDevLocal=true selects the DEBUG variant (unminified, dev ingest URL) " +
                    "and a -DEV version; neither belongs on Maven Central, and it cannot be unpublished.\n" +
                    "  Offending task(s): ${bundleTasks.joinToString(", ") { it.path }}\n" +
                    "  Drop -PeverframeDevLocal (and any everframeDevLocal in ~/.gradle/gradle.properties) " +
                    "to publish a real release.",
            )
        }
    }
}

subprojects {
    pluginManager.withPlugin("maven-publish") {
        extensions.configure<org.gradle.api.publish.PublishingExtension> {
            repositories {
                maven {
                    name = "CentralBundle"
                    url = rootProject.layout.buildDirectory.dir("central-bundle/repository").get().asFile.toURI()
                }
            }
        }
    }

    pluginManager.withPlugin("com.android.library") {
        // AGP 8.7's built-in `withJavadocJar()` runs an older embedded Dokka
        // that cannot read Kotlin 2.1 sealed-class bytecode. Use current Dokka
        // to generate real API documentation instead of falling back to an
        // empty Maven Central placeholder JAR.
        pluginManager.apply("org.jetbrains.dokka-javadoc")
        val dokkaJavadoc = tasks.named("dokkaGeneratePublicationJavadoc")
        val dokkaJavadocJar = tasks.register<Jar>("dokkaJavadocJar") {
            description = "A Javadoc JAR containing generated Dokka API documentation."
            dependsOn(dokkaJavadoc)
            from(dokkaJavadoc.map { it.outputs.files })
            archiveClassifier.set("javadoc")
        }
        pluginManager.withPlugin("maven-publish") {
            afterEvaluate {
                extensions.configure<org.gradle.api.publish.PublishingExtension> {
                    publications.withType<org.gradle.api.publish.maven.MavenPublication>().configureEach {
                        artifact(dokkaJavadocJar)
                    }
                }
            }
        }
    }

    afterEvaluate {
        // Pin compileSdk/minSdk centrally for all Android library/application modules.
        extensions.findByType(com.android.build.gradle.LibraryExtension::class.java)?.apply {
            compileSdk = 35
            defaultConfig {
                minSdk = 24
                targetSdk = 35
            }
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_17
                targetCompatibility = JavaVersion.VERSION_17
            }
            // Plan 05-08 — every Android library module emits a `release` software
            // component that downstream `MavenPublication { from(components["release"]) }`
            // wires up. Setting `singleVariant("release")` keeps the published AAR
            // pointed at the release variant only (the customer never debug-consumes).
            //
            // Publish source and API documentation alongside each AAR. The SDK
            // source is MIT-licensed and lives in the public repository.
            publishing {
                // `release` normally; `debug` under -PeverframeDevLocal=true, which
                // is the only variant that carries a local ingest URL. See the
                // gate's comment at the top of this file.
                singleVariant(everframePublishVariant) {
                    withSourcesJar()
                }
            }
        }
        extensions.findByType(com.android.build.gradle.AppExtension::class.java)?.apply {
            compileSdkVersion(35)
            defaultConfig {
                minSdk = 24
                targetSdkVersion(35)
            }
        }
    }
}

val cleanCentralBundleRepository = tasks.register<Delete>("cleanCentralBundleRepository") {
    delete(layout.buildDirectory.dir("central-bundle"))
}

val publishAllToCentralBundle = tasks.register("publishAllToCentralBundle") {
    group = "publishing"
    description = "Write signed Everframe publications into a local Central Portal Maven-layout bundle."
    dependsOn(
        subprojects.map { sub ->
            sub.tasks.matching { it.name == "publishAllPublicationsToCentralBundleRepository" }
        },
    )
}

subprojects {
    tasks.matching {
        it.name.startsWith("publish") &&
            it.name.endsWith("PublicationToCentralBundleRepository")
    }.configureEach {
        dependsOn(cleanCentralBundleRepository)
    }
}

tasks.register<Zip>("centralPortalBundle") {
    group = "publishing"
    description = "Create the signed Maven-layout zip accepted by the Central Portal Publisher API."
    dependsOn(publishAllToCentralBundle)
    from(layout.buildDirectory.dir("central-bundle/repository"))
    destinationDirectory.set(layout.buildDirectory.dir("central-bundle"))
    archiveFileName.set("everframe-android-${everframeVersionResolved}.zip")
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

// Plan 05-08 — convenience aggregate task: dry-run for CI without credentials.
// `--dry-run` skips upload; verifies the publish task graph is wired correctly.
tasks.register("publishAllToMavenLocal") {
    group = "publishing"
    description = "Publish every Everframe Android module to mavenLocal (dev)."
    dependsOn(subprojects.map { it.path + ":publishToMavenLocal" })
}
