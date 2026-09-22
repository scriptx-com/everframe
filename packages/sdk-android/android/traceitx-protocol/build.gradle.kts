// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// :traceitx-protocol — quicktype-generated kotlinx-serialization data classes for ReportEnvelope.
// Sole purpose is to host Generated.kt; consumers depend on this module from :traceitx-core.

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    `maven-publish`
    signing
}

android {
    namespace = "com.traceitx.protocol"
    defaultConfig {
        consumerProguardFiles("consumer-rules.pro")
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(libs.serialization.json)

    // PROTO-02 cross-SDK round-trip test (Plan 06-06 Task 3). JVM unit test;
    // never reaches releaseRuntimeClasspath (Compose-isolation gate stays green).
    testImplementation(libs.junit)
}

// Maven Central publishing — see traceitx-core/build.gradle.kts for env-var
// contract. Same pattern as the other modules; minimal POM differences.
afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components[rootProject.extra["traceitxPublishVariant"] as String])
                groupId = "com.traceitx"
                artifactId = "protocol"
                version = project.version.toString()
                pom {
                    name.set("TraceItX Android — protocol")
                    description.set("Generated kotlinx-serialization data classes for the TraceItX ReportEnvelope wire format.")
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
            logger.warn("[traceitx-protocol] GPG signing skipped — SIGNING_KEY / SIGNING_PASSWORD not set.")
        }
    }
}
