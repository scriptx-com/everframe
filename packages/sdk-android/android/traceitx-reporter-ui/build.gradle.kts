// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// :traceitx-reporter-ui — Compose-based reporter UI for phone + tablet.
// Opt-in artifact; depends on :traceitx-core.
//
// Material/Foundation/Animation pulled in HERE (allowed); Plan 01's
// Compose-isolation gate forbids them in :traceitx-core only.

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    `maven-publish`
    signing
}

android {
    namespace = "com.traceitx.reporter.ui"
    defaultConfig {
        // Plan 05-06 — instrumented runner for ReporterDialog + BubbleAttacher tests.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildTypes {
        getByName("release") {
            // Library-level R8: matches the :traceitx-core release variant.
            // proguard-rules.pro keeps the public reporter entry points
            // (TXReporterPresenter, ReporterResolverInstaller) and the
            // @Composable surface; everything else obfuscates.
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    buildFeatures {
        compose = true
        // ShakeDetector reads BuildConfig.DEBUG to gate the production OFF default.
        buildConfig = true
    }
    testOptions {
        unitTests {
            isIncludeAndroidResources = true   // Robolectric in ShakeDetectorTest needs merged resources
            isReturnDefaultValues = true
        }
    }
}

dependencies {
    implementation(project(":traceitx-core"))
    // ReporterDialog JSON-decodes the host-attached React tree (Phase 6
    // attachReactTree). :traceitx-core has serialization.json as
    // `implementation` (not api) so it does not propagate — declare it
    // directly here.
    implementation(libs.serialization.json)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.runtime)
    implementation(libs.compose.material3)
    implementation(libs.compose.foundation)
    implementation(libs.compose.animation)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.startup.runtime)
    implementation(libs.coroutines.android)

    // JVM unit tests (Plan 05-06) — testImplementation only.
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.coroutines.test)
    // Final whole-branch review, Important 2 — ReporterDialogSubmitBoundaryTest's
    // identity-epoch case reaches a real (local) HTTP request via
    // ReporterDialog.__submitterFactoryForTesting, mirroring
    // CompanionSubmissionComposerTest's identical use of these in :traceitx-core.
    testImplementation(libs.mockwebserver)
    testImplementation(libs.okhttp)

    // Instrumented tests — separate APK; never enters releaseRuntimeClasspath.
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.espresso.core)
    androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}

// Maven Central publishing — see traceitx-core/build.gradle.kts for the full
// rationale + env-var contract (OSSRH_USERNAME, SIGNING_KEY, etc.).
afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components[rootProject.extra["traceitxPublishVariant"] as String])
                groupId = "com.traceitx"
                artifactId = "reporter-ui"
                version = project.version.toString()
                pom {
                    name.set("TraceItX Android — reporter-ui")
                    description.set("Compose-based reporter UI for phone + tablet (Material 3 modal, freehand annotation, redaction, bake-before-export).")
                    url.set("https://traceitx.com")
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
                        connection.set("scm:git:https://github.com/scriptx-com/traceitx-releases.git")
                        developerConnection.set("scm:git:ssh://git@github.com/scriptx-com/traceitx-releases.git")
                        url.set("https://github.com/scriptx-com/traceitx-releases")
                    }
                    issueManagement {
                        system.set("GitHub")
                        url.set("https://github.com/scriptx-com/traceitx-releases/issues")
                    }
                }
            }
        }
        repositories {
            maven {
                name = "Sonatype"
                // Central Portal OSSRH Staging API compatibility endpoint.
                val releasesUrl = uri("https://ossrh-staging-api.central.sonatype.com/service/local/staging/deploy/maven2/")
                val snapshotsUrl = uri("https://central.sonatype.com/repository/maven-snapshots/")
                url = if (version.toString().endsWith("SNAPSHOT")) snapshotsUrl else releasesUrl
                credentials {
                    username = System.getenv("OSSRH_USERNAME")
                        ?: project.findProperty("ossrh.username")?.toString()
                    password = System.getenv("OSSRH_PASSWORD")
                        ?: project.findProperty("ossrh.password")?.toString()
                }
            }
        }
    }

    signing {
        val signingKey = System.getenv("SIGNING_KEY")
            ?: project.findProperty("signing.key")?.toString()
        val signingPassword = System.getenv("SIGNING_PASSWORD")
            ?: project.findProperty("signing.password")?.toString()
        if (signingKey != null && signingPassword != null) {
            useInMemoryPgpKeys(signingKey, signingPassword)
            sign(publishing.publications["release"])
        } else {
            logger.warn("[traceitx-reporter-ui] GPG signing skipped — SIGNING_KEY / SIGNING_PASSWORD not set. publishToMavenLocal still works; Sonatype upload will fail without signatures.")
        }
    }
}

// Release-variant unit tests (Plan: soft-launch CI repair, 2026-08-10).
//
// Every test in this module is a pure-logic test over `internal` types —
// annotation geometry and model, the wire format, image transforms, shot-list
// ops, bake ordering, session arbitration. The release variant runs them
// against R8-minified classes (isMinifyEnabled above, with proguard-rules.pro
// keeping only the public reporter entry points), so R8 renames every one of
// those internal types and all 8 classes die with NoClassDefFoundError before
// a single assertion runs: 55 failures, zero signal.
//
// This is the same failure `:traceitx-core` already documented for
// CompanionAnnounceTest, and the same remedy — exclude rather than add `-keep`
// rules, which would pin internal helpers into the published AAR's symbol
// table purely to satisfy a test. The difference is only one of degree: there
// it was one class, here it is the module's entire test source set, so
// disabling the task says what 8 identical exclusions would say, more plainly.
//
// Correctness coverage for this module lives on the debug variant
// (`testDebugUnitTest`, green). What the RELEASE artifact needs verified is
// that R8 kept what consumers call, and that is what the keep rules plus the
// APK symbol check in android/README.md cover — a job unit tests compiled
// against the minified jar were never doing.
tasks.matching { it.name == "testReleaseUnitTest" }.configureEach {
    enabled = false
}
