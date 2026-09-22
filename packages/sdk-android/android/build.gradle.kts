// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Root Gradle build for the TraceItX Android SDK (Plan 05-01 + 05-08).
// Plugins are declared at the root with `apply false` so each subproject opts in.
//
// Plan 05-08: Maven publish coordination — every Android library subproject
// auto-applies `maven-publish` + a release `MavenPublication`. Customers consume via
// `com.traceitx:<module>:<version>` after authenticating with a fine-grained PAT
// (see `android/README.md` for the recipe).

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
// `gradle.properties:traceitxVersion`; override per-build with
// `-PtraceitxVersion=X.Y.Z`. The 0.0.0-LOCAL default only fires if both are
// missing — a deliberately-invalid SemVer so an unconfigured environment
// produces an obviously-broken artifact instead of a silent SNAPSHOT push.
// --- Local-dev publishing gate ------------------------------------------
// `-PtraceitxDevLocal=true` is the ONE switch that distinguishes "I am
// dogfooding against my laptop" from "this artifact is going to consumers".
// It changes two things together, and they must move together:
//
//   1. the published VARIANT flips release -> debug, and
//   2. the version gains a `-DEV` suffix.
//
// (1) is the point. `traceitx-core`'s release variant hardcodes
// INGEST_URL = https://traceitx.com and deliberately refuses to read
// TRACEITX_DEV_INGEST_URL — an env-var fallback there once let a maintainer
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
// SAFETY — why this cannot leak to Maven Central: the flag swaps which
// component the SINGLE publication is built from; it never adds a second
// publication. `publishAllToSonatype` runs `publishAllPublicationsTo…` with
// no flag set, so the only publication that exists in that build is the
// release one, exactly as before. Do not "improve" this by declaring both
// publications at once — that is precisely how a debug AAR reaches consumers.
val traceitxDevLocal: Boolean =
    (project.findProperty("traceitxDevLocal") as String?)?.toBoolean() ?: false
val traceitxPublishVariant: String = if (traceitxDevLocal) "debug" else "release"
val traceitxVersionResolved: String =
    ((project.findProperty("traceitxVersion") as String?) ?: "0.0.0-LOCAL")
        .let { if (traceitxDevLocal) "$it-DEV" else it }
allprojects {
    group = "com.traceitx"
    version = traceitxVersionResolved
    // Read by each module's MavenPublication. Kept here rather than recomputed
    // per module so the variant and the version can never disagree.
    extra["traceitxPublishVariant"] = traceitxPublishVariant
}
if (traceitxDevLocal) {
    logger.lifecycle(
        "[traceitx] DEV-LOCAL publish: variant=$traceitxPublishVariant version=$traceitxVersionResolved " +
            "(ingest URL comes from TRACEITX_DEV_INGEST_URL; NOT publishable to Maven Central)",
    )
    // HARD STOP on the remote path. The gate above only changes which component
    // the publication is built from — the publication is still NAMED 'release',
    // so `publishReleasePublicationToSonatypeRepository` stays enabled and would
    // happily upload the debug AAR: unminified, and carrying whatever ingest URL
    // the developer had exported. Maven Central cannot be rewritten, so that is
    // permanent. "CI never passes the flag" is not a safeguard — a developer
    // with credentials and the flag in their shell or ~/.gradle.properties is
    // exactly the situation the release variant's own comment was written about.
    //
    // Fails when the graph is READY rather than in a doFirst, so the build stops
    // before any task runs instead of part-way through a publish.
    gradle.taskGraph.whenReady {
        val remote = allTasks.filter { it.name.contains("ToSonatypeRepository") }
        if (remote.isNotEmpty()) {
            error(
                "Refusing to publish a dev-local build to Sonatype.\n" +
                    "  -PtraceitxDevLocal=true selects the DEBUG variant (unminified, dev ingest URL) " +
                    "and a -DEV version; neither belongs on Maven Central, and it cannot be unpublished.\n" +
                    "  Offending task(s): ${remote.joinToString(", ") { it.path }}\n" +
                    "  Drop -PtraceitxDevLocal (and any traceitxDevLocal in ~/.gradle/gradle.properties) " +
                    "to publish a real release.",
            )
        }
    }
}

subprojects {
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
                // `release` normally; `debug` under -PtraceitxDevLocal=true, which
                // is the only variant that carries a local ingest URL. See the
                // gate's comment at the top of this file.
                singleVariant(traceitxPublishVariant) {
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

// Convenience aggregate task: publishes every subproject's release publication
// to the shared remote Maven repository.
//
// Renamed from `publishAllToGitHubPackages` on 2026-08-10. Each module's
// publishing block now declares a repository named **Sonatype**
// (central.sonatype.com — see the `publishing { repositories { maven { ... } } }`
// block in each module's build.gradle.kts), so the per-project task this
// aggregate depended on —
// `:<module>:publishAllPublicationsToGitHubPackagesRepository` — no longer
// exists under any module. Gradle cannot resolve a dependsOn to a
// non-existent task path, so the aggregate failed at configuration time with
// "Could not determine the dependencies of task ':publishAllToGitHubPackages'"
// and android.yml's publish-dry-run job could not even build its task graph.
//
// The publishing target moved and this aggregate was never updated with it;
// the workflow had been disabled since 2026-05-11, so nothing reported it.
// The dependency is a lazily-resolved TaskCollection per subproject, NOT a
// hardcoded task path. Only :traceitx-protocol, :traceitx-core,
// :traceitx-reporter-ui and :traceitx-media3 declare the Sonatype repository;
// :traceitx-gradle-plugin does not publish there, so a literal
// ":traceitx-gradle-plugin:publishAllPublicationsToSonatypeRepository" is an
// unresolvable path and Gradle fails the whole aggregate at configuration time
// — the same class of breakage as the stale GitHub Packages name, just one
// module further along. `tasks.matching {}` contributes nothing for a
// subproject that has no such task, so adding or removing a publishable module
// needs no edit here.
tasks.register("publishAllToSonatype") {
    group = "publishing"
    description = "Publish every publishable TraceItX Android module to the Sonatype (Maven Central) repository."
    dependsOn(
        subprojects.map { sub ->
            sub.tasks.matching { it.name == "publishAllPublicationsToSonatypeRepository" }
        },
    )
}

// Plan 05-08 — convenience aggregate task: dry-run for CI without credentials.
// `--dry-run` skips upload; verifies the publish task graph is wired correctly.
tasks.register("publishAllToMavenLocal") {
    group = "publishing"
    description = "Publish every TraceItX Android module to mavenLocal (dev)."
    dependsOn(subprojects.map { it.path + ":publishToMavenLocal" })
}
