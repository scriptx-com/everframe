// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// :everframe-core — capture + envelope + transport + outbox.
//
// Compose isolation contract (Pitfall 14): only `androidx.compose.ui` (Modifier +
// SemanticsPropertyKey for Modifier.txSensitive in Plan 05-03) and
// `androidx.compose.runtime` (Composable annotation reachability for R8 keep rules)
// are allowed. Material/Material3/Foundation/Animation/TV must NEVER appear here —
// they live in :everframe-reporter-ui.

import java.io.File

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    // Phase 05.2 Plan 01 — Compose compiler plugin enabled so the
    // androidTest source set can compile inline-Composable widgets
    // (Material3 Button/Text/OutlinedTextField + foundation Column) for
    // the Compose instrumented suites. The plugin only affects @Composable
    // compilation. Production source hosts exactly ONE @Composable —
    // dev.everframe.TXScreen (screen-marker spec 2026-07-14), runtime-only,
    // no Material — the Compose-isolation contract now reads: no Material,
    // no new Compose deps, runtime+ui only.
    alias(libs.plugins.kotlin.compose)
    `maven-publish`
    signing
}

android {
    namespace = "dev.everframe"
    defaultConfig {
        consumerProguardFiles("consumer-rules.pro")
        // Plan 05-03 — instrumented test runner for ScreenshotCapture + Compose tests.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Single source of truth for the SDK version: gradle.properties'
        // everframeVersion (overridable with -PeverframeVersion=X.Y.Z). The
        // root build.gradle.kts pushes that into `project.version` for all
        // modules; we surface it to runtime Kotlin via BuildConfig.SDK_VERSION
        // so `Everframe.SDK_VERSION` can never drift from the Maven coordinate
        // again.
        buildConfigField("String", "SDK_VERSION", "\"${project.version}\"")
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // Per-variant ingest URL. Release variant ALWAYS gets the prod URL — the
    // dev override is unreachable from the published AAR (no env-var lookup,
    // no string literal "EVERFRAME_DEV_INGEST_URL" anywhere in release
    // bytecode). The debug variant picks up the env var at library build
    // time so local sample apps can target localhost / a LAN IP.
    buildTypes {
        getByName("debug") {
            val devUrl = System.getenv("EVERFRAME_DEV_INGEST_URL")?.takeIf { it.isNotBlank() }
                ?: "http://10.0.2.2:8787"
            buildConfigField("String", "INGEST_URL", "\"$devUrl\"")
        }
        getByName("release") {
            // Hardcoded, NOT read from the environment. This mirrors iOS, where
            // the dev override lives behind `#if DEBUG` and is compiled out of
            // the shipped xcframework (see IngestEndpoint.swift).
            //
            // A `System.getenv("EVERFRAME_DEV_INGEST_URL")` fallback lived here
            // for a while, marked "TEMP … REVERT before commit" and committed
            // anyway. It made the invariant stated above false: a maintainer
            // with the dev override exported — which is exactly the state after
            // a local dogfooding session — would publish an immutable AAR
            // pointing at their laptop. Nothing would error; every consumer's
            // reports would simply never arrive. Maven Central cannot be
            // rewritten, so that AAR would be permanent. Do not reintroduce it:
            // point a local sample app at a dev ingest with the DEBUG variant.
            buildConfigField("String", "INGEST_URL", "\"https://everframe.dev\"")
            // Library-level R8: the published AAR's classes.jar is obfuscated
            // (internal symbols collapsed to short ids, debug info stripped).
            // `proguard-rules.pro` keeps the public API surface; everything
            // else is fair game. `consumer-rules.pro` (declared on
            // defaultConfig above) STILL ships inside the AAR for the
            // consumer's own R8 pass — componentPath reflection + Compose
            // semantics walks live there.
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
    buildFeatures {
        // No Compose buildFeature here — the Kotlin 2.x compose compiler
        // plugin (plugins block) is what compiles the single production
        // @Composable (dev.everframe.TXScreen); the AGP buildFeature flag is
        // legacy and stays off.
        //
        // Plan 05-05 — generate BuildConfig so MultipartUploader can gate its
        // DEBUG-only response-body preview on `BuildConfig.DEBUG`. AGP 8.7+
        // makes BuildConfig opt-in for library modules.
        buildConfig = true
    }
    // Shared investigation candidate is test-only; no Compose semantics adapter ships in core.
    sourceSets.getByName("test").java.srcDir("src/testShared/kotlin")
    sourceSets.getByName("androidTest").java.srcDir("src/testShared/kotlin")

    testOptions {
        unitTests {
            isIncludeAndroidResources = true   // Robolectric needs merged assets (Plan 05-02)
            isReturnDefaultValues = true
            // Forward the VTreeAndroidE2eGoldenTest regeneration flag into the
            // forked test JVM. The golden test rewrites the committed
            // `android-walk-sample.vtree.v1.json` artifact ONLY when
            // -Dvtree.regenerate=true is set; without this passthrough the flag
            // stays on the Gradle daemon and never reaches the test. Default
            // (unset) → the test ASSERTS against the committed bytes.
            all { test ->
                // The full API 24/25/35 Robolectric matrix exceeds Gradle's
                // default 512 MiB test-worker heap. Daemon org.gradle.jvmargs
                // does not configure this JVM. Keep one bounded worker.
                test.maxHeapSize = "2g"
                test.maxParallelForks = 1
                val detailsCorpus = rootProject.file("../../protocol/__tests__/fixtures/crash-details-native-parity.json")
                test.inputs.file(detailsCorpus)
                test.systemProperty("everframeCrashDetailsCorpus", detailsCorpus.absolutePath)
                providers.gradleProperty("everframeCrashDetailsOutput").orNull?.let { output ->
                    val destination = File(output)
                    require(destination.isAbsolute) { "everframeCrashDetailsOutput must be absolute" }
                    require(destination.parentFile.isDirectory) { "Crash details export parent must exist" }
                    test.systemProperty("everframeCrashDetailsOutput", destination.absolutePath)
                    test.outputs.upToDateWhen { false }
                    test.outputs.cacheIf { false }
                }
                val fixture = providers.gradleProperty("everframeR8FixtureJar").orNull
                if (fixture == null) {
                    test.exclude("**/acceptance/R8CaptureAcceptanceTest*")
                } else {
                    listOf("everframeR8FixtureJar", "everframeR8MappingId", "everframeR8EnvelopeOutput", "everframeR8AppId").forEach { name ->
                        test.systemProperty(name, providers.gradleProperty(name).get())
                    }
                    test.inputs.file(fixture)
                    // Capture must execute afresh and persist unique reports on every explicit run.
                    test.outputs.upToDateWhen { false }
                    test.outputs.cacheIf { false }
                }
                System.getProperty("vtree.regenerate")?.let {
                    test.systemProperty("vtree.regenerate", it)
                }
            }
        }
    }
}

// Companion (spec 2026-08-07) — `CompanionAnnounceTest` is a DEBUG-variant test.
// It class-loads `dev.everframe.companion.CompanionAnnounce` by name, and that
// type is `internal`, so the release variant's R8 pass (isMinifyEnabled above,
// keeping only the public API per proguard-rules.pro:8-14) renames it and the
// whole class fails with `NoClassDefFoundError: com/everframe/companion/
// CompanionAnnounce` before any assertion runs. Excluding it here is preferred
// over a `-keep` rule, which would pin an internal helper into the published
// AAR's symbol table for the sake of a test. Same shape, and the same remedy, as
// `packages/sdk-react-native/android/build.gradle.kts`'s test exclusions.
//
// The announce leg still has release-variant coverage: `RelayWSClientAnnounceTest`
// exercises it end to end through the real socket path without naming any
// obfuscated type.
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>()
    .matching { it.name == "compileReleaseUnitTestKotlin" }
    .configureEach {
        exclude("**/companion/CompanionAnnounceTest.kt")
    }

// Release-variant unit tests (soft-launch CI repair, 2026-08-10).
//
// The exclusion directly above treated CompanionAnnounceTest as one class with
// an unlucky dependency on an `internal` type. It is not — it was the first
// instance of a property that holds for this whole source set. Measured on
// this commit: `:everframe-core:testReleaseUnitTest` produces 162 failures,
// every one a NoClassDefFoundError / NoSuchMethodError, because these tests
// name internal types (Everframe's own gates and buffers, BreadcrumbAdapters,
// LogCapture, the replay session) that R8 renames under `isMinifyEnabled` +
// proguard-rules.pro's keep-the-public-API-only policy. There is no assertion
// signal in the run at all — it fails at class load.
//
// So the release variant is disabled here for the same reason, and with the
// same tradeoff, the CompanionAnnounceTest comment already argues: the
// alternative is `-keep` rules that pin internal symbols into the published
// AAR to satisfy tests, which makes the shipped artifact worse to make CI
// green. `:everframe-reporter-ui` carries the identical block for the identical
// reason.
//
// This is not a coverage loss: `testDebugUnitTest` runs the same tests,
// unminified, and is green. What the release AAR actually needs verified —
// that R8 kept everything consumers call — is the job of the keep rules and
// the APK symbol check documented in android/README.md, which unit tests
// compiled against the minified jar were never performing.
//
// android.yml runs `testReleaseUnitTest testDebugUnitTest`; with this task
// disabled that command reaches the debug tests instead of dying on the
// release ones, which is why the workflow had been red since 2026-05-11.
tasks.matching { it.name == "testReleaseUnitTest" }.configureEach {
    enabled = false
}

// Plan 05-02 — keep `assets/everframe/*.json` in lockstep with `packages/protocol/data/*.json`.
// The shared JSON is the cross-language source of truth for redaction/sensitive headers.
// preBuild dependency means every gradle build (including unit tests via the test task graph)
// re-syncs the assets before compile/resource-merge.
tasks.register<Copy>("copyProtocolData") {
    // $rootDir is packages/sdk-android/android/ — protocol data lives two
    // levels up at packages/protocol/data/ (was one level up before the
    // android SDK moved under packages/sdk-android/).
    from("$rootDir/../../protocol/data")
    into("src/main/assets/everframe")
    include("*.json")
}
tasks.named("preBuild") { dependsOn("copyProtocolData") }

dependencies {
    api(project(":everframe-protocol"))
    implementation(libs.okhttp)
    implementation(libs.coroutines.android)
    implementation(libs.serialization.json)
    implementation(libs.androidx.annotation)
    implementation(libs.datastore.preferences)
    // Plan 06.2-08 — RelayWSClient observes ProcessLifecycleOwner to cancel the
    // WS on app-backgrounded and reconnect on app-foregrounded. Pure AndroidX;
    // does NOT pull Compose/Material into the AAR (Compose-isolation gate stays green).
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.common)
    // Plan 05-05 — AndroidX Security Crypto for DeviceKey EncryptedFile (T-04-19 analog;
    // replaces iOS Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` with
    // EncryptedFile under filesDir).
    implementation(libs.security.crypto)
    // Minimum Compose surface for Modifier.txSensitive (Plan 05-03 SemanticsPropertyKey).
    implementation(libs.compose.ui)
    implementation(libs.compose.runtime)

    // Plan 05-04 — Timber as compileOnly. Production AAR has no transitive Timber.
    // LogCapture references `timber.log.Timber.Tree` directly, but every call site is
    // gated by `Class.forName("timber.log.Timber")` inside TimberDetector — JVMs that
    // lack Timber never reach the symbol-resolution path.
    compileOnly(libs.timber)

    // JVM unit tests (Plan 05-02) — testImplementation only; never bleeds into releaseRuntimeClasspath.
    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    // Privacy fixtures use ComponentActivity in both debug and release compilation.
    testImplementation(libs.androidx.activity.compose)
    testImplementation(libs.coroutines.test)
    // Plan 05-04 — Timber on the test classpath so LogCaptureTest can verify
    // idempotent plant + uprootAll-never-called. MockWebServer for EverframeInterceptorTest.
    // Both testImplementation only — releaseRuntimeClasspath unaffected.
    testImplementation(libs.timber)
    testImplementation(libs.mockwebserver)
    // Task 8 (session vitals) — TestLifecycleOwner for VitalsLifecycleObserverTest.
    testImplementation(libs.androidx.lifecycle.runtime.testing)

    // Instrumented tests (Plan 05-03) — androidTestImplementation only. These do NOT
    // appear on releaseRuntimeClasspath, so the Compose-isolation gate (Plan 01) stays
    // green even though we pull in compose.foundation + ui-test here. The test APK is
    // a separate artifact from the published AAR. Documented in 05-03-SUMMARY.md.
    androidTestImplementation(libs.mockwebserver)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.espresso.core)
    // androidTest ONLY. Fresco is the Drawee stack React Native's <Image> is
    // built on (`ReactImageView` -> `GenericDraweeView` -> `DraweeView` extends
    // `ImageView`), and it installs a wrapper drawable with no `ConstantState`
    // — the exact shape the design once believed made RN uncapturable. The
    // instrumented suite pins what actually happens now. Test classpath only,
    // so it never reaches releaseRuntimeClasspath or the published AAR.
    androidTestImplementation(libs.fresco)
    androidTestImplementation(libs.compose.foundation)
    // Phase 05.2 Plan 01 — Material3 widgets (Button/Text/OutlinedTextField) on
    // androidTestImplementation only so the Compose instrumented suites can
    // build realistic Login/Payment/Detail screens. Test classpath does NOT bleed
    // into releaseRuntimeClasspath, so the Compose-isolation contract (Plan 01)
    // stays green; this mirrors the existing compose.foundation + ui-test
    // pattern documented above. BOM resolves the versionless material3 alias.
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.material3)
    androidTestImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}

// ---------------------------------------------------------------------------
// Maven Central publishing — coordinates: dev.everframe:core:<version>
//
// Required signing env vars (see PUBLISHING.md for setup):
//   * SIGNING_KEY                      — ascii-armored secret key (newlines
//                                        preserved; export with `gpg --armor
//                                        --export-secret-keys $KEY_ID`)
//   * SIGNING_PASSWORD                 — passphrase for the secret key
//
// Sources and API documentation are attached by the root Android publishing
// configuration through AGP's release software component.
// ---------------------------------------------------------------------------

afterEvaluate {
    publishing {
        publications {
            create<MavenPublication>("release") {
                from(components[rootProject.extra["everframePublishVariant"] as String])
                groupId = "dev.everframe"
                artifactId = "core"
                version = project.version.toString()
                pom {
                    name.set("Everframe Android — core")
                    description.set("Native Android SDK core for Everframe bug reporting: capture, envelope, transport, outbox.")
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
                    issueManagement {
                        system.set("GitHub")
                        url.set("https://github.com/scriptx-com/everframe/issues")
                    }
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
            logger.warn("[everframe-core] GPG signing skipped — SIGNING_KEY / SIGNING_PASSWORD not set. Local Maven publishing still works; Central Portal bundles require signatures.")
        }
    }
}
