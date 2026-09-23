// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 9 (spec 2026-08-12) — proves `Everframe.setUser(...)` actually reaches
// the wire envelope. Before this task `_user` was stored (Everframe.kt:678-682)
// and never read; `EnvelopeBuilder.buildEncoded`'s `user` parameter already
// worked (EnvelopeBuilder.kt:409, `TXUserExtras.toGenerated()` at :434-440),
// but nothing at any real `buildEncoded` call site passed it in.
//
// Drives the CrashReporter call site (crash/CrashReporter.kt:141) end to
// end — synchronous and network-free, unlike the companion/reporter-dialog
// submit paths — and decodes the real sidecar bytes (mirrors
// CrashReporterTest's idiom), so a regression here means the real call site
// stopped wiring the user, not merely that EnvelopeBuilder's own `user`
// plumbing broke (that's a separate concern, already exercised elsewhere).
package dev.everframe

import dev.everframe.outbox.JceTestOutboxKeyProvider
import dev.everframe.outbox.JvmOutboxFileOps

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.everframe.capture.NetworkRingBuffer
import dev.everframe.capture.sharedBreadcrumbBuffer
import dev.everframe.capture.sharedNetworkBuffer
import dev.everframe.config.CaptureConfig
import dev.everframe.config.IdentityConfigWire
import dev.everframe.config.ReplayConfig
import dev.everframe.config.TXUser
import dev.everframe.config.EverframeConfig
import dev.everframe.crash.CrashReporter
import dev.everframe.identity.IdentityTokenSource
import dev.everframe.outbox.CrashSidecar
import dev.everframe.outbox.JSONLOutbox
import dev.everframe.outbox.OutboxEntry
import dev.everframe.shared.SharedData
import dev.everframe.transport.ReportSubmitter
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class EnvelopeUserTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val config = EverframeConfig(capture = CaptureConfig(logs = false), appId = "app", sdkKey = "sk")
    private var probeCounter = 0
    private lateinit var crashOutbox: JSONLOutbox

    @Before
    fun setUp() {
        SharedData.init(context)
        // setUser() is a no-op while captureGate is closed (Everframe.kt:680) —
        // mirrors CrashReporterTest's setup, which flips the gate directly
        // rather than paying for a full Everframe.start().
        Everframe.captureGate = true
        CrashReporter.__resetForTesting()
        val dir = kotlin.io.path.createTempDirectory("envelope-crash").toFile()
        val keys = JceTestOutboxKeyProvider()
        val ops = JvmOutboxFileOps()
        crashOutbox = JSONLOutbox(File(dir, "outbox.jsonl"), keys, ops)
        CrashReporter.sidecarFactory = { CrashSidecar(File(dir, "crash-outbox.jsonl"), keys, ops) }
        sidecarFile().delete()
        // The heavy-init tail this suite awaits ends with a drain of the shared
        // outbox. Entries left there by an earlier test (or an earlier suite)
        // would each turn that drain into a real HTTP attempt against the dev
        // ingest URL — seconds of connect timeout per await, for nothing this
        // suite asserts on.
        outboxFile().delete()
        CrashReporter.configure(context)
        // CrashReporter no longer caches a config of its own — it reads the one
        // in the crash-entry snapshot — so the config has to be installed on
        // Everframe itself. `__setConfigForTesting` sets `_config` under
        // `stateLock` without running start()'s heavy-init tail, which is what
        // keeps the "no full start()" choice above intact. tearDown's kill()
        // clears it again.
        Everframe.__setConfigForTesting(config)
        Everframe.setUser(null)
    }

    @After
    fun tearDown() {
        // Everframe._user and captureGate are process-global statics; leaking
        // either bleeds into other suites sharing this JVM worker (mirrors
        // CrashReporterTest's tearDown).
        Everframe.setUser(null)
        CrashReporter.__resetForTesting()
        // Round-5 finding 2 — the crash tests below can leave a DIFFERENT
        // project installed (and its heavy-init state live); kill() bumps the
        // start epoch and tears that down so the next test in this JVM worker
        // starts clean. Also clears the identity token and
        // __replayConfigOverrideForTesting (armIdentityEnabled()'s seam), so
        // no identity-enabled state leaks into a later suite either.
        Everframe.kill()
        Everframe.captureGate = false
    }

    private fun sidecarFile() = File(File(context.cacheDir, "dev.everframe"), "crash-outbox.jsonl")

    /** The shared outbox `start()`'s heavy-init tail drains (JSONLOutbox.kt:291). */
    private fun outboxFile() = File(File(context.cacheDir, "dev.everframe"), "outbox.jsonl")

    /**
     * Bounded poll for the heavy-init tail of the `start()` just issued.
     *
     * MANDATORY after every `start()` in this suite, including inside a
     * `__afterUserSnapshotHookForTesting` body. That tail runs on
     * `Dispatchers.IO` and one of its steps is
     * `CrashSidecar.hydrateInto(sharedOutbox)`, which MOVES the crash sidecar
     * into the outbox — the very file this suite writes its crashes to and
     * reads straight back. Left unawaited, that hydrate lands at an arbitrary
     * moment: fall between `captureThrowable` and the read and the entry is
     * simply gone, which fails the key cases for a reason unrelated to what
     * they test and — worse — makes the two `kill` cases pass VACUOUSLY, since
     * a stolen report is indistinguishable from a suppressed one.
     *
     * Awaiting inside the window puts the hydrate strictly BEFORE the crash is
     * appended, where it finds an empty sidecar and is a no-op. `_replaySession`
     * is assigned by the LAST statement of that coroutine's sequential body and
     * `start()` nulls it synchronously first, so non-null is a sound
     * "everything upstream, drain included, already ran" signal — the same
     * idiom, for the same reason, as `EverframeLogWiringTest.awaitHeavyInit()`.
     */
    private fun awaitHeavyInit(timeoutMs: Long = 5_000) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (Everframe._replaySession == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(5)
        }
        assertNotNull(
            "start()'s heavy-init tail never completed — the sidecar read below would race it",
            Everframe._replaySession,
        )
    }

    /**
     * A project config for the cases that drive the REAL `Everframe.start()`
     * because they are about a genuine session switch.
     *
     * `capture.logs = false` is test hygiene, not part of what is under test —
     * the same idiom, for the same documented reason, as
     * `EverframeTest.validConfig()`: `start()`'s heavy-init tail installs the
     * PROCESS-WIDE System.out/err tee (`Everframe.kt`'s `start.logCapture` step)
     * from a detached Dispatchers.IO coroutine that nothing here awaits, and
     * unlike the `start.replay` step it is NOT epoch-guarded, so it can land
     * after tearDown's `kill()` has already uninstalled. Keeping the gate false
     * means no tee is ever armed and the race cannot arise from this suite.
     * Nothing here reads logs: crash envelopes exclude them (`excluded`).
     *
     * That race is a PRODUCTION defect, not a property of this suite —
     * `LogCapture.install()` claims its `installed` latch before it swaps the
     * streams, and `uninstall()` restores after clearing it, so the two can
     * interleave into a permanently-wrapped `System.out` with `installed ==
     * false`. It is recorded under "Correctness nits" in
     * `the public behavior contract`,
     * where a production race belongs; this comment only explains why this
     * suite steps around it.
     */
    private fun project(appId: String, sdkKey: String) =
        EverframeConfig(appId = appId, sdkKey = sdkKey, capture = CaptureConfig(logs = false))

    /**
     * Drives one real `CrashReporter.captureThrowable` call — the actual
     * production call site — and returns the decoded `reporter` object from
     * the envelope it persisted to the crash sidecar.
     */
    private fun captureAndReadReporter(): JsonObject {
        CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("boom"))
        val entries = runBlocking { crashOutbox.hydrate() }
        assertEquals(1, entries.size)
        val entry = entries.single()
        val envelope = Json.parseToJsonElement(String(entry.envelopeBytes)).jsonObject
        // `reporter` is a top-level field, a sibling of `payload` — never
        // envelope.payload.reporter.
        return envelope["reporter"]!!.jsonObject
    }

    /**
     * Sibling of [captureAndReadReporter] that returns the raw persisted
     * [OutboxEntry] instead of the decoded envelope, or null when the capture
     * wrote nothing at all (a revoked capture — see the kill-during-processing
     * cases below).
     */
    private fun captureAndReadEntry(): OutboxEntry? {
        CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("boom"))
        return runBlocking { crashOutbox.hydrate() }.firstOrNull()
    }

    private fun jwt(sub: String, expMs: Long): String {
        val payload = buildJsonObject {
            put("sub", sub)
            put("exp", expMs / 1000)
        }
        val header = """{"alg":"HS256","typ":"JWT"}"""
        fun b64(s: String) = java.util.Base64.getUrlEncoder().withoutPadding()
            .encodeToString(s.toByteArray(Charsets.UTF_8))
        return "${b64(header)}.${b64(payload.toString())}.not-a-real-signature"
    }

    /**
     * Arms `__replayConfigOverrideForTesting` with an identity-enabled
     * config — `captureUserSnapshot()`/`captureSessionSnapshot()` now also
     * check `isIdentityEnabled` before stamping `identitySubject`
     * (independent review, round 4, Serious 3). `kill()` in [tearDown]
     * already clears the override.
     */
    private fun armIdentityEnabled() {
        Everframe.__replayConfigOverrideForTesting = ReplayConfig(
            replayEnabled = false,
            replayDurationSec = 30,
            samplingRate = 1.0,
            identity = IdentityConfigWire(enabled = true),
        )
    }

    @Test
    fun `setUser reaches the envelope`() {
        Everframe.setUser(TXUser(id = "u_1", email = "a@b.com", displayName = "A"))
        val user = captureAndReadReporter()["user"]!!.jsonObject
        assertEquals("u_1", user["id"]!!.jsonPrimitive.content)
        assertEquals("a@b.com", user["email"]!!.jsonPrimitive.content)
        assertEquals("A", user["displayName"]!!.jsonPrimitive.content)
    }

    @Test
    fun `email-only user is supported`() {
        // The spec's keying rule falls back to email; a required id would have
        // silently dropped this case on Android only.
        Everframe.setUser(TXUser(email = "a@b.com"))
        val user = captureAndReadReporter()["user"]!!.jsonObject
        // explicitNulls = false on the encoder (EnvelopeBuilder.kt:480) means an
        // absent field is a MISSING key, not a JSON null — a `TXUser` carrying
        // only an email must survive as partially populated, not empty strings.
        assertNull("id must be absent, not an empty string", user["id"])
        assertNull("displayName must be absent, not an empty string", user["displayName"])
        assertEquals("a@b.com", user["email"]!!.jsonPrimitive.content)
    }

    @Test
    fun `no user yields no reporter user`() {
        Everframe.setUser(null)
        val reporter = captureAndReadReporter()
        assertNull(reporter["user"])
    }

    // ---- Crash entry boundary (round-5 external review, finding 2) ----------

    /**
     * `CrashReporter.capture` used to read `Everframe.currentUser` inline at the
     * `buildEncoded` call — after `RedactionEngine` had run over the message
     * and every one of up to 256 frames, after fingerprinting and after
     * `DeviceMetadata.collect`. `captureThrowable` runs on whichever thread
     * threw, while the rest of the app is still live, so a `setUser(B)` landing
     * in that window attributed A's crash to B.
     *
     * The user is now snapshotted at CRASH ENTRY (first statement of
     * `captureThrowable`/`captureFacts`) and resolved at encode time.
     * `__afterUserSnapshotHookForTesting` stands in for that window
     * deterministically — a real background `setUser` race would only fail this
     * test sometimes.
     */
    @Test
    fun `a crash carries the user active at crash entry, not at encode time`() {
        Everframe.setUser(TXUser(id = "u_1", email = "a@b.com", displayName = "A"))
        CrashReporter.__afterUserSnapshotHookForTesting = {
            Everframe.setUser(TXUser(id = "u_2", email = "b@b.com", displayName = "B"))
        }

        val user = captureAndReadReporter()["user"]!!.jsonObject

        // Non-vacuity: the switch really did land inside the processing window.
        assertEquals("u_2", Everframe.currentUser?.id)
        assertEquals(
            "the crash must carry the user active at crash ENTRY, not whoever " +
                "setUser named while it was being encoded",
            "u_1",
            user["id"]!!.jsonPrimitive.content,
        )
        assertEquals("a@b.com", user["email"]!!.jsonPrimitive.content)
        assertEquals("A", user["displayName"]!!.jsonPrimitive.content)
    }

    /**
     * The control the finding explicitly calls for: with nothing switching in
     * the window, the crash still carries its user. A "fix" that dropped the
     * user unconditionally would pass the case above and fail here.
     */
    @Test
    fun `a crash keeps its user when nothing switches during processing`() {
        Everframe.setUser(TXUser(id = "u_1", email = "a@b.com", displayName = "A"))
        var hookRan = false
        CrashReporter.__afterUserSnapshotHookForTesting = { hookRan = true }

        val user = captureAndReadReporter()["user"]!!.jsonObject

        assertTrue("the crash-processing window hook never fired", hookRan)
        assertEquals("u_1", user["id"]!!.jsonPrimitive.content)
        assertEquals("a@b.com", user["email"]!!.jsonPrimitive.content)
        assertEquals("A", user["displayName"]!!.jsonPrimitive.content)
    }

    /**
     * The project-crossing half: a `start(projectB)` during crash processing
     * must degrade the crash to anonymous rather than ship project A's person.
     * The trailing `setUser` is what makes this discriminating — `start()`
     * clears the LIVE user, so without it the case would pass even against the
     * old live read and would only be exercising the epoch guard.
     *
     * Started through [project] (i.e. with `capture.logs = false`) for the
     * log-tee hygiene reason documented there — this call site used to pass a
     * default config, making it the one place in this suite that armed the
     * process-wide tee from a coroutine nobody awaits.
     */
    @Test
    fun `a crash is anonymous when another project starts during processing`() {
        Everframe.setUser(TXUser(id = "u_1", email = "a@b.com", displayName = "A"))
        CrashReporter.__afterUserSnapshotHookForTesting = {
            Everframe.start(
                context,
                project("other-app", "txx_live_other1234567890"),
            )
            awaitHeavyInit()
            Everframe.setUser(TXUser(id = "u_2", email = "b@b.com", displayName = "B"))
        }

        val reporter = captureAndReadReporter()

        // Non-vacuity: project B really is the installed session, with its own
        // signed-in user, by the time the envelope is assembled.
        assertEquals("other-app", Everframe.currentConfig?.appId)
        assertEquals("u_2", Everframe.currentUser?.id)
        assertNull(
            "a crash captured under project A must never ship A's person once project B is installed",
            reporter["user"],
        )
    }

    // ---- Crash-entry session snapshot: the config travels with the user ----
    //
    // The assertions below are about the OutboxEntry itself (its `sdkKey` — the
    // project the bytes are uploaded to — and whether an entry exists at all),
    // not about the envelope's `reporter` object, so they read the entry
    // through `captureAndReadEntry` rather than `captureAndReadReporter`.
    //
    // Argument order note: this suite asserts with org.junit.Assert, whose
    // messages come FIRST (assertEquals(message, expected, actual)); the values
    // and messages below are otherwise exactly as specified.

    /**
     * The key on the wire must be the key of the session the crash happened
     * in, not whichever project was installed by the time the entry was built.
     *
     * What this pins: the `sdkKey` stamped on the `OutboxEntry` comes from the
     * CRASH-ENTRY snapshot, not from a live config read taken later. Replace
     * `cfg.sdkKey` at the entry construction with a `Everframe.currentConfig`
     * read — by that line redaction, fingerprinting and device collection have
     * all run, and the hook's `start(projectB)` has landed — and this case
     * fails with `sk_b`. That late-read shape is the iOS-side variant of this
     * defect (fixed in 808f482c/dfd446de); the same hazard on Android is what
     * the snapshot removes.
     *
     * What this does NOT pin, despite the task it landed in: the absence of
     * `CrashReporter`'s deleted `@Volatile config` cache. That was a
     * *different* defect — a second source of truth written outside
     * `Everframe.stateLock` — and no test driving this hook can catch it,
     * because `capture()` reads the config at its top (`CrashReporter.kt:168`)
     * BEFORE the hook fires (`:174`). A switch inside the window cannot change
     * that read in either version. What guards the cache's absence is
     * structural: `configure()` no longer takes a config, so nothing can feed
     * such a field, and restoring it makes this suite plus `CrashReporterTest`
     * and `CrashDeliveryTest` fail outright — the crash path early-returns and
     * writes no report at all.
     */
    @Test
    fun `a crash is stamped with the key of the project it was captured under`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        CrashReporter.configure(context)
        CrashReporter.__afterUserSnapshotHookForTesting = {
            Everframe.start(context, project("app_b", "sk_b"))
            awaitHeavyInit()
        }

        val entry = captureAndReadEntry()

        assertEquals("precondition: the hook switched the live config", "sk_b", Everframe.currentConfig?.sdkKey)
        assertNotNull(entry)
        assertEquals(
            "the crash must ship under the key of the project it happened in",
            "sk_a",
            entry!!.sdkKey,
        )
    }

    /** Control: entering the window changes nothing when nothing switches. */
    @Test
    fun `a crash keeps its key when nothing switches during processing`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        CrashReporter.configure(context)
        var hookRan = false
        CrashReporter.__afterUserSnapshotHookForTesting = { hookRan = true }

        val entry = captureAndReadEntry()

        assertTrue("the hook must have run — otherwise this asserts nothing", hookRan)
        assertEquals("sk_a", entry!!.sdkKey)
    }

    @Test
    fun `a kill during processing drops the report entirely`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        CrashReporter.configure(context)
        CrashReporter.__afterUserSnapshotHookForTesting = { Everframe.kill() }

        assertNull("a revoked capture must not reach the sidecar", captureAndReadEntry())
    }

    /** The case a boolean gate cannot express — start() re-opens captureGate. */
    @Test
    fun `a kill followed by a start still drops the report`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        CrashReporter.configure(context)
        CrashReporter.__afterUserSnapshotHookForTesting = {
            Everframe.kill()
            Everframe.start(context, project("app_b", "sk_b"))
            awaitHeavyInit()
        }

        val entry = captureAndReadEntry()

        // AFTER the capture, not before: run ahead of it and this witnesses
        // nothing, since setUp and this test's own start() have already left
        // the gate open. Read here it is the real precondition — the hook's
        // start() re-opened the gate that its kill() had closed, so a
        // capture-time boolean check would have let this report through.
        assertTrue("precondition: start() re-opened the gate", Everframe.captureGate)
        assertNull("a later start() must not resurrect a revoked capture", entry)
    }

    // ---- Crash entry identitySubject boundary (independent review, P1) ------

    /**
     * Independent review, P1 — the crash path has the identical shape to
     * `ReporterDialog.kt`/`CompanionSubmissionComposer.kt`'s live-submit fix.
     * `captured.user.resolve()` (asserted just above by `a crash is anonymous
     * when another project starts during processing`) already drops the
     * self-declared USER on an epoch mismatch — but the raw
     * `captured.user.identitySubject` field, unlike `.resolve()`'s user, had
     * no epoch gate of its own before this fix, so `CrashReporter.kt` used to
     * persist it onto the `OutboxEntry` unconditionally even when the
     * captured session no longer matched. A later drain could then attach a
     * header on the strength of a subject the SDK had already concluded,
     * via the SAME epoch check, it should not rely on.
     *
     * Project B is ALSO given a live token for the SAME `sub` ("alice"), so
     * a persisted subject would still (wrongly) match a live token if the
     * fix regressed — this proves the withholding is the epoch check, not
     * an incidental subject mismatch.
     *
     * Merge note (native-identity x captured-session): adapted to the
     * `project()`/`awaitHeavyInit()` harness `captureAndReadEntry()`'s sibling
     * tests above now use, and to `captureAndReadEntry()`'s nullable return.
     */
    @Test
    fun `a crash outbox entry carries no identitySubject when another project starts during processing`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        CrashReporter.configure(context)
        // Non-vacuity (independent review, round 4, Serious 3): arm identity
        // as ENABLED before the capture, so the nil assertion below is
        // attributable to the epoch mismatch this test targets, not merely
        // the round-4/5 identity-enabled gate defaulting to off.
        armIdentityEnabled()
        val now = System.currentTimeMillis()
        Everframe.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))
        CrashReporter.__afterUserSnapshotHookForTesting = {
            Everframe.start(context, project("app_b", "sk_b"))
            awaitHeavyInit()
            Everframe.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))
        }

        val entry = captureAndReadEntry()

        // Non-vacuity: project B really is installed, with its own live
        // "alice" token, by the time the entry is enqueued.
        assertEquals("sk_b", Everframe.currentConfig?.sdkKey)
        assertNotNull(entry)
        assertNull(
            "a crash entry captured under project A must never persist a subject once project B has " +
                "started during processing — even though B's live token's sub (\"alice\") still matches. " +
                "An epoch mismatch means the SDK already decided the whole captured snapshot is " +
                "untrustworthy, not just the self-declared user half of it.",
            entry!!.identitySubject,
        )
    }

    /**
     * The control the finding explicitly calls for: with nothing switching
     * in the window, the crash entry still carries the captured subject. A
     * "fix" that dropped identitySubject unconditionally would pass the
     * case above and fail here.
     */
    @Test
    fun `a crash outbox entry keeps its identitySubject when nothing switches during processing`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        CrashReporter.configure(context)
        // Independent review, round 4 (Serious 3) — this test's own point
        // is the hook mechanism, not the identity-enabled gate, so arm it
        // the same way the sibling test above does.
        armIdentityEnabled()
        val now = System.currentTimeMillis()
        Everframe.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))
        var hookRan = false
        CrashReporter.__afterUserSnapshotHookForTesting = { hookRan = true }

        val entry = captureAndReadEntry()

        assertTrue("the crash-processing window hook never fired", hookRan)
        assertNotNull(entry)
        assertEquals("alice", entry!!.identitySubject)
    }

    // ---- Identity-disabled capture boundary (independent review, round 4, Serious 3) ----

    /**
     * `captureUserSnapshot()`/`captureSessionSnapshot()` used to stamp
     * `identitySubject` from the token cache unconditionally — never
     * consulting whether identity is even ENABLED for the project. The live
     * submit boundary already correctly withholds the header via
     * `resolveIdentityHeader`'s own `isIdentityEnabled` check, but the raw
     * subject still reached the persisted `OutboxEntry` — inconsistent with
     * the header decision, the same shape as the round-4 epoch fix. A later
     * drain could then attach a header on the strength of a subject captured
     * while the SDK had already decided, at capture time, not to attribute
     * anything.
     *
     * Deliberately does NOT call `armIdentityEnabled()` — identity is
     * disabled by default (fail-closed; `currentReplayConfig()` falls back
     * to `ReplayConfig.OFF` with no `_replaySession` installed) unless a
     * test explicitly arms it.
     */
    @Test
    fun `a crash outbox entry carries no identitySubject when identity is disabled at capture`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        CrashReporter.configure(context)
        val now = System.currentTimeMillis()
        Everframe.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))

        val entry = captureAndReadEntry()

        assertNotNull(entry)
        assertNull(
            "a crash entry captured while identity is disabled for the project must never persist a " +
                "subject, even with a live cached token",
            entry!!.identitySubject,
        )
    }

    /**
     * Non-vacuity / negative control: the SAME token, with identity ENABLED
     * at capture, DOES get stamped — proving the case above tests the
     * enabled gate specifically, not e.g. a broken token cache.
     */
    @Test
    fun `a crash outbox entry carries the identitySubject when identity is enabled at capture`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        CrashReporter.configure(context)
        armIdentityEnabled()
        val now = System.currentTimeMillis()
        Everframe.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))

        val entry = captureAndReadEntry()

        assertNotNull(entry)
        assertEquals("alice", entry!!.identitySubject)
    }

    // ---- Delayed-drain project staleness (independent review, round 8, Serious 1) ----

    /**
     * THE scenario the finding describes: a drain is initiated under
     * project A — a [ReportSubmitter] constructed with A's config, with
     * `epochAtInitiation` captured synchronously in the SAME breath,
     * exactly like `Everframe.kt`'s real `requestOutboxDrain()`/`start()`
     * drain kickoff — but does not actually RUN until after
     * `start(projectB)` has already landed, with project B ALSO
     * identity-enabled and a live token for the SAME subject (plausible:
     * `sub` is the host's own user id, unchanged across a tenant switch).
     *
     * The bug this closes: the OLD `drainOutbox` sampled its own epoch
     * baseline from INSIDE its own body (`epochAtDrainStart =
     * currentEpoch()`), which by the time the function actually ran would
     * already reflect project B — a baseline that LOOKS like a valid
     * "nothing changed" reading but is actually the wrong reference point
     * entirely. `entry.sdkKey == config.sdkKey` (comparing the entry
     * against the SUBMITTER's own frozen config, still "A") kept passing
     * regardless, so project B's LIVE bearer token — resolved because its
     * subject happens to match — could attach to a request still
     * authorized with project A's SDK key, uploaded to project A's
     * endpoint: disclosure of a live credential to the wrong project's
     * host, not merely misattribution (`aud` verification stops the
     * latter but not the former).
     *
     * Mutation-verified: reverting `drainOutbox` to derive its baseline
     * internally (ignoring the caller-supplied `epochAtInitiation`) makes
     * this fail — B's live token attaches.
     */
    @Test
    fun `a delayed drain withholds the header when another project starts before it runs`() = runBlocking {
        val projectA = EverframeConfig(capture = CaptureConfig(logs = false), appId = "project-a-app-id", sdkKey = "txx_live_projectA1234567890")
        val projectB = EverframeConfig(capture = CaptureConfig(logs = false), appId = "project-b-app-id", sdkKey = "txx_live_projectB0987654321")

        Everframe.start(context, projectA)
        awaitHeavyInit()
        armIdentityEnabled()
        val now = System.currentTimeMillis()
        Everframe.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))

        val server = MockWebServer()
        server.start()
        val outboxFile = File(context.cacheDir, "delayed-drain-test-${probeCounter++}.jsonl")
        try {
            // An entry captured under project A, identity enabled, alice
            // signed in — a real subject reaches the entry.
            val outbox = JSONLOutbox(outboxFile, keys = JceTestOutboxKeyProvider(), ops = JvmOutboxFileOps())
            outbox.enqueue(
                OutboxEntry(
                    reportId = "r-delayed-drain",
                    createdAt = now,
                    envelopeBytes = "{}".toByteArray(),
                    idempotencyKey = "idem-delayed-drain",
                    attachmentRefs = emptyList(),
                    sdkKey = projectA.sdkKey,
                    endpoint = server.url("/api/ingest").toString(),
                    identitySubject = "alice",
                ),
            )

            // Mirrors Everframe.kt's own drain kickoff exactly: a submitter
            // constructed under project A's config, with epochAtInitiation
            // captured synchronously in the same breath — the values a
            // real caller has BEFORE any coroutine-scheduling delay.
            // `endpointOverride` is set to the SAME MockWebServer URL the
            // entry itself carries (`endpointUrl` — not `entry.endpoint` —
            // is what the header decision's live-endpoint comparison
            // reads); the actual upload destination is still driven by
            // `entry.endpoint` alone, per drainOutbox's own established
            // routing rule, so this changes nothing about where the
            // request lands.
            val submitter = ReportSubmitter(
                config = projectA,
                outbox = outbox,
                endpointOverride = server.url("/api/ingest").toString(),
            )
            val epochAtInitiation = Everframe.currentStartEpoch()

            // NOW project B lands — standing in for the real
            // coroutine-scheduling delay between a drain being initiated
            // and actually running. ALSO identity-enabled, ALSO a token
            // for "alice": the exact same-subject-different-project shape
            // that makes B's live token look, superficially, like it
            // belongs to this entry.
            Everframe.start(context, projectB)
            awaitHeavyInit()
            Everframe.setIdentityToken(IdentityTokenSource.Token(jwt(sub = "alice", expMs = now + 300_000)))

            server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
            submitter.drainOutbox(
                identityHolder = Everframe._identityHolder,
                currentReplayConfig = {
                    ReplayConfig(
                        replayEnabled = false, replayDurationSec = 30, samplingRate = 1.0,
                        identity = IdentityConfigWire(enabled = true),
                    )
                },
                epochAtInitiation = epochAtInitiation,
                currentEpoch = { Everframe.currentStartEpoch() },
            )

            // Non-vacuity: project B really is installed, with its own
            // live "alice" token, by the time the drain actually runs.
            assertEquals(projectB.appId, Everframe.currentConfig?.appId)

            val recorded = server.takeRequest(10, java.util.concurrent.TimeUnit.SECONDS)
            assertTrue("the entry must still drain — degrading to anonymous, never being lost", recorded != null)
            assertNull(
                "project B's live token must never attach to a request still authorized with project " +
                    "A's SDK key, even though B's token subject matches and B is also identity-enabled — " +
                    "the drain was initiated under project A and must be judged against project A's " +
                    "epoch, not whatever project happens to be live once the drain actually runs.",
                recorded?.getHeader("X-TX-Identity-Token"),
            )
        } finally {
            server.shutdown()
            outboxFile.delete()
        }
    }

    // ---- Session-boundary buffer reset (2026-08-13 follow-ups item 10) ----

    /**
     * Markers chosen so they cannot be produced by accident — the
     * whole-envelope substring assertion below can then only pass or fail for
     * the buffer content under test.
     */
    private val crumbMarkerA = "TXFOLLOWUP10-PROJECT-A-ONLY-CRUMB"
    private val urlMarkerA = "https://a-only.example.invalid/txfollowup10-a-only-path"

    /**
     * Same real `CrashReporter.captureThrowable` drive as
     * [captureAndReadReporter], returning the WHOLE envelope as text.
     * `payload.breadcrumbs` is what is under test; asserting on the raw text
     * as well means a marker that moved elsewhere in the envelope still fails
     * the test instead of slipping past a field-specific reader.
     */
    private fun captureAndReadEnvelopeText(): String {
        CrashReporter.captureThrowable(Thread.currentThread(), IllegalStateException("boom"))
        val entries = runBlocking { crashOutbox.hydrate() }
        assertEquals(1, entries.size)
        val entry = entries.single()
        return String(entry.envelopeBytes)
    }

    /**
     * THE DEFECT (follow-ups item 10). `start()` zeroized the network-BODY
     * buffer at the session boundary but not the breadcrumb chain, so
     * `start(A) -> activity -> start(B)` left A's crumbs in the process-global
     * ring and the next ordinary report in B shipped them to B's project.
     * Deterministic, unbounded, cross-tenant — the same class as follow-ups
     * items 1 and 6.
     *
     * Driven through `CrashReporter.captureThrowable` because that is the real
     * call site in this module that builds an envelope from
     * `sharedBreadcrumbBuffer` (`CrashReporter.kt`'s `snapshotForCrash()`).
     * `ReporterDialog` reads the same buffer on the screenshot-reporter path
     * but lives in `:everframe-reporter-ui`, which this module's tests cannot
     * reach.
     */
    @Test
    fun `a report in the next project ships none of the previous project's breadcrumbs`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        Everframe.addBreadcrumb(message = crumbMarkerA)

        // Non-vacuity: the crumb must really be in the ring before the switch,
        // or the absence asserted below proves nothing.
        assertTrue(
            "precondition: A's crumb must be buffered before start(B) — otherwise this test asserts nothing",
            sharedBreadcrumbBuffer.snapshotForCrash().any { it.message == crumbMarkerA },
        )

        Everframe.start(context, project("app_b", "sk_b"))
        awaitHeavyInit()
        CrashReporter.configure(context)

        val envelopeText = captureAndReadEnvelopeText()
        val breadcrumbs = Json.parseToJsonElement(envelopeText)
            .jsonObject["payload"]!!.jsonObject["breadcrumbs"]
            ?.jsonArray.orEmpty()
        assertFalse(
            "a report in project B must not carry project A's breadcrumb chain",
            breadcrumbs.any { it.jsonObject["message"]?.jsonPrimitive?.content == crumbMarkerA },
        )
        assertFalse(
            "project A's crumb text must appear NOWHERE in a project B envelope",
            envelopeText.contains(crumbMarkerA),
        )
    }

    /**
     * The metadata half of the same defect: `sharedNetworkBuffer` holds URLs,
     * status codes and timings, and `kill()` zeroizes it while `start()` did
     * not.
     *
     * Asserted at the buffer rather than through a built envelope on purpose.
     * The only production reader of these rows is `ReporterDialog`
     * (`sharedNetworkBuffer.snapshot()` mapped into `EnvelopeBuilder`'s
     * `network` argument), which lives in `:everframe-reporter-ui` — out of
     * reach from `:everframe-core`'s unit tests. `snapshot()` IS the exact
     * value that call site ships, so pinning it empty pins what the report
     * carries; re-deriving the row mapping here would test this file's copy of
     * production logic instead of production's.
     */
    @Test
    fun `the next project starts with none of the previous project's network rows`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        sharedNetworkBuffer.push(
            NetworkRingBuffer.Entry(
                timestamp = 1_700_000_000_000L,
                method = "GET",
                url = urlMarkerA,
                status = 200,
                durationMs = 12L,
                requestHeaders = emptyMap(),
                responseHeaders = emptyMap(),
                errorMessage = null,
            ),
        )
        assertTrue(
            "precondition: A's network row must be buffered before start(B) — otherwise this test asserts nothing",
            sharedNetworkBuffer.snapshot().any { it.url == urlMarkerA },
        )

        Everframe.start(context, project("app_b", "sk_b"))
        awaitHeavyInit()

        assertTrue(
            "start(B) must zeroize project A's captured network metadata rows — a report in B reads this same buffer",
            sharedNetworkBuffer.snapshot().isEmpty(),
        )
    }

    // ---- Session-snapshot revocation (2026-08-13 follow-ups item 9) ----

    /**
     * `TXCapturedSession.isRevoked` is what lets the submit boundaries — one
     * of which is in a different Gradle module and cannot see `internal`
     * `killGenerationChanged` at all — refuse a report whose session was
     * killed mid-assembly. This pins its semantics, including the case a
     * boolean gate check cannot express.
     */
    @Test
    fun `a session snapshot reports revoked only after a kill`() {
        Everframe.start(context, project("app_a", "sk_a"))
        awaitHeavyInit()
        val captured = Everframe.captureSessionSnapshot()
        assertFalse("a live session must not report itself revoked", captured.isRevoked)

        Everframe.kill()
        assertTrue("a snapshot taken before kill() must report revoked after it", captured.isRevoked)

        // start() re-opens captureGate, so a boolean gate check would report
        // "fine" here — only a monotonic counter survives a restart.
        Everframe.start(context, project("app_b", "sk_b"))
        awaitHeavyInit()
        assertTrue("a restart must not un-revoke a snapshot", captured.isRevoked)
    }

    // ---- captureSessionSnapshot() config/epoch atomicity (independent
    // review, round 9, P1 — originally proven against the now-removed
    // `TXCapturedConfig`/`captureConfigSnapshot()`, superseded by
    // `TXCapturedSession`/`captureSessionSnapshot()`, which reads config,
    // user (incl. `startEpoch`) and the revocation counter from the SAME
    // `stateLock` acquisition. See `EverframeConfigSnapshotWiringSourceGateTest`
    // for the wiring pin that covers what a behavioural test cannot.) ----

    /** Before the first `start()`, the snapshot's config is null — the same
     *  fail-closed default `currentConfig` itself resolves to. */
    @Test
    fun `captureSessionSnapshot has no config before start`() {
        Everframe.kill()
        val snapshot = Everframe.captureSessionSnapshot()
        assertNull(snapshot.config)
    }

    /** The ordinary case: the snapshot's config and epoch both reflect
     *  whichever project is currently installed, together. */
    @Test
    fun `captureSessionSnapshot pairs the live config with its own epoch`() {
        val projectA = EverframeConfig(capture = CaptureConfig(logs = false), appId = "project-a-app-id", sdkKey = "txx_live_projectA1234567890")
        Everframe.start(context, projectA)

        val snapshot = Everframe.captureSessionSnapshot()

        assertEquals(projectA.appId, snapshot.config?.appId)
        assertEquals(Everframe.currentStartEpoch(), snapshot.user.startEpoch)
    }

    /**
     * A second `start()` moves BOTH fields together — never one project's
     * config paired with a different project's epoch. This is the
     * behavioural half of what `captureSessionSnapshot()`'s single
     * `stateLock` acquisition guarantees structurally: the actual race this
     * closes (`start(projectB)` landing BETWEEN a config read and a
     * separately-read epoch) cannot be reproduced as a behavioural test any
     * more — the fix removes the window entirely, which is the point. See
     * `EverframeConfigSnapshotWiringSourceGateTest` for the wiring pin that
     * covers what a behavioural test cannot.
     */
    @Test
    fun `captureSessionSnapshot moves config and epoch together across a restart`() {
        val projectA = EverframeConfig(capture = CaptureConfig(logs = false), appId = "project-a-app-id", sdkKey = "txx_live_projectA1234567890")
        val projectB = EverframeConfig(capture = CaptureConfig(logs = false), appId = "project-b-app-id", sdkKey = "txx_live_projectB0987654321")

        Everframe.start(context, projectA)
        val epochAtA = Everframe.captureSessionSnapshot().user.startEpoch

        Everframe.start(context, projectB)
        val snapshotAtB = Everframe.captureSessionSnapshot()

        // Non-vacuity: the epoch really did change, so a snapshot pairing
        // project A's config with THIS epoch would be a genuinely
        // detectable mismatch if it could ever occur.
        assertTrue(snapshotAtB.user.startEpoch != epochAtA)
        assertEquals(projectB.appId, snapshotAtB.config?.appId)
        assertEquals(Everframe.currentStartEpoch(), snapshotAtB.user.startEpoch)
    }
}
