// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// :traceitx-media3 — Session Vitals playback tracking for Media3/ExoPlayer.
// Opt-in artifact; depends on :traceitx-core.
//
// trackPlayer(exoPlayer) attaches an AnalyticsListener that maps ExoPlayer's
// callback vocabulary onto the vitals player event vocabulary (spec
// 2026-09-05 §3): buffering, bitrate/quality, DRM, errors, startup timings
// and per-tick stats.

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    `maven-publish`
    signing
}

android {
    namespace = "com.traceitx.media3"
    kotlinOptions {
        jvmTarget = "17"
    }
    defaultConfig {
        // Ship the public-surface keeps to the HOST app's own R8 pass. Without
        // this, `TrackPlayerKt` / `Media3Integration` survive publish-time R8
        // (proguard-rules.pro) but are renamed again in the customer's release
        // APK — see consumer-rules.pro's header.
        consumerProguardFiles("consumer-rules.pro")
    }
    buildTypes {
        getByName("release") {
            // Library-level R8: matches the :traceitx-core release variant.
            // proguard-rules.pro keeps the public trackPlayer() entry point
            // and the Media3Integration class; everything else obfuscates.
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    buildFeatures {
        buildConfig = false
    }
}

dependencies {
    api(project(":traceitx-core"))
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.common)
    implementation(libs.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
}

// Maven Central publishing — see traceitx-core/build.gradle.kts for the full
// rationale + env-var contract (OSSRH_USERNAME, SIGNING_KEY, etc.).
afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components[rootProject.extra["traceitxPublishVariant"] as String])
                groupId = "com.traceitx"
                artifactId = "media3"
                version = project.version.toString()
                pom {
                    name.set("TraceItX Android — media3")
                    description.set("Session Vitals playback tracking for Media3/ExoPlayer: trackPlayer(exoPlayer) feeds buffering, bitrate, DRM, errors and per-tick stats into the session timeline.")
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
            logger.warn("[traceitx-media3] GPG signing skipped — SIGNING_KEY / SIGNING_PASSWORD not set. publishToMavenLocal still works; Sonatype upload will fail without signatures.")
        }
    }
}

// Release-variant unit tests (mirrors :traceitx-reporter-ui's identical gate).
//
// Every test in this module is a pure-logic test over `internal` types — the
// facade seam and the AnalyticsListener mapping. The release variant runs
// them against R8-minified classes (isMinifyEnabled above, with
// proguard-rules.pro keeping only the public trackPlayer() entry point and
// Media3Integration), so R8 renames the internal types and the tests die
// with NoClassDefFoundError before a single assertion runs — same failure
// :traceitx-core and :traceitx-reporter-ui already document, same remedy:
// exclude rather than add `-keep` rules that would pin internal helpers into
// the published AAR's symbol table purely to satisfy a test.
//
// Correctness coverage for this module lives on the debug variant
// (`testDebugUnitTest`, green).
tasks.matching { it.name == "testReleaseUnitTest" }.configureEach {
    enabled = false
}
