// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding 1 (Serious) — a user captured at the Send tap could
// still be uploaded under a DIFFERENT project's SDK key. Android half; mirrors
// iOS `TXCapturedUser.swift` one-for-one (same mechanism, same failure mode).
//
// The previous round fixed two halves of this area independently and, between
// them, opened a third hole:
//
//   * `start()`/`kill()` clear `_user`, so a live read can never see project
//     A's user once project B is installed.
//   * the submit paths STOPPED reading the live `_user` and instead snapshot
//     it at the Send tap, so an account switch mid-submit cannot repoint a
//     finished report.
//
// But the SDK CONFIGURATION — which carries the SDK key and therefore the
// project every byte is uploaded to — is still read later, inside the
// asynchronous submission (`ReporterDialog.submitBaked`'s and
// `CompanionSubmissionComposer.submit`'s `Everframe.currentConfig` reads). Those
// two reads are not atomic, so:
//
//     setUser(A) -> [Send tap: snapshot A] -> start(projectB) -> submit reads
//     project B's config -> A's id/email/display name uploaded under B's key
//
// creates a falsely attributed person in a different customer's project. The
// `start()`-clears-the-user fix is precisely what makes the SURVIVING captured
// value dangerous: the live singleton is clean, the snapshot is not.
//
// The remedy uses the mechanism this SDK already has for exactly this class of
// bug: `Everframe._startEpoch`, a monotonically increasing generation counter
// bumped under `stateLock` by BOTH `start()` and `kill()` (see its KDoc, and
// `StartEpochGuardTest` for the established precedent of capturing it and
// re-checking it later). Capturing the user and the epoch in ONE `stateLock`
// critical section makes the pair atomic; re-checking the epoch at
// envelope-assembly time discards the snapshot the instant a superseding
// `start()`/`kill()` has run.
//
// Degrading to anonymous is the correct failure mode: recognition must never
// fail or delay a report, and losing attribution is always preferable to
// attributing to the wrong person or — as here — the wrong project.
//
// Native identity Task 7 — the identity subject joins this same snapshot as a
// third field, for the identical reason: the report being captured now must
// be bound to whichever identity was active AT THIS INSTANT, not whichever is
// active when the (asynchronous, possibly minutes-later) submit finally runs.
// Kotlin twin of `TXCapturedUser.swift`'s identical addition (native identity
// Task 3).
package dev.everframe

import dev.everframe.config.TXUser
import dev.everframe.config.EverframeConfig

/**
 * A self-declared user (`setUser`, spec 2026-08-12) snapshotted at a submit
 * boundary, TOGETHER with the SDK session it was snapshotted in AND the
 * verified-identity subject (recognition spec 2026-08-06) active at that same
 * instant.
 *
 * Obtain one only from [Everframe.captureUserSnapshot] — the constructor is
 * `internal` so the three fields can never be captured separately (a user
 * read at one instant, an epoch read at another and a subject read at a third
 * is the exact non-atomicity this type exists to remove — reading any pair of
 * the three apart from the third reopens the same hazard `startEpoch` was
 * added to close).
 *
 * [TXUser] is an immutable data class, so the captured user is a snapshot by
 * construction; nothing can mutate it after the fact.
 *
 * [ConsistentCopyVisibility] is what makes the `internal constructor` above
 * mean anything. A `data class` synthesizes `copy()` at the visibility of the
 * CLASS, not of the constructor, so without this annotation a host could write
 * `snapshot.copy(user = someoneElse)` and hand the result to [resolve] —
 * re-opening by the back door the separate-capture hole the internal
 * constructor closes at the front.
 */
@ConsistentCopyVisibility
data class TXCapturedUser internal constructor(
    /**
     * The user installed when this snapshot was taken. `null` when no
     * `setUser` had been called (the ordinary anonymous case).
     */
    val user: TXUser?,
    /**
     * `Everframe._startEpoch` as of the same `stateLock` critical section that
     * read [user]. Compared against the live epoch by [resolve].
     */
    val startEpoch: Int,
    /**
     * The verified-identity `sub` this report was CAPTURED under — read from
     * `IdentityTokenHolder.cachedSubject(nowMs:)` in the same `stateLock`
     * critical section as [user]/[startEpoch]. `null` when no identity token
     * was cached and presentable at capture time (no host-set token, an
     * expired/stale one, or a cold cache — capture is synchronous and must
     * never block on a provider, so a cold cache stamps the report
     * anonymous). `resolveIdentityHeader` compares this against whatever
     * identity is active at submit time and withholds the header on any
     * mismatch, exactly like [resolve] does for [user]/[startEpoch].
     */
    val identitySubject: String?,
) {
    /**
     * The captured user, or `null` if the session it was captured in is no
     * longer the installed one — i.e. a `start()` (possibly with a different
     * project's SDK key) or a `kill()` has run since the capture.
     *
     * Call this where the envelope is assembled, AFTER the config that will
     * carry the upload has been read. That ordering is what makes the pair safe
     * without one lock spanning both: the epoch increases monotonically, so an
     * epoch that still matches here proves no `start()`/`kill()` ran at any
     * point between the capture and this call — including the moment the config
     * was read, which is therefore this same session's config.
     *
     * Never throws, never blocks on anything but the short `stateLock`.
     */
    fun resolve(): TXUser? = Everframe.resolveCapturedUser(this)
}

/**
 * The whole session a crash was captured under, read in ONE [Everframe.stateLock]
 * critical section.
 *
 * [TXCapturedUser] fixed half of this: the user could no longer be paired with
 * a session it did not belong to. The config was still read separately a few
 * statements later, so a `start(projectB)` landing in that window built project
 * A's crash and stamped it with B's key (follow-ups item 6). Capturing the
 * config alongside removes the second read, which is why routing no longer
 * depends on what the epoch says.
 *
 * Wraps [TXCapturedUser] rather than flattening it, so `resolve()` and its
 * epoch rule stay exactly where they were.
 *
 * Obtain one only from [Everframe.captureSessionSnapshot]. The constructor is
 * `internal` and [ConsistentCopyVisibility] closes `copy()` with it, for the
 * same reason as [TXCapturedUser]: three fields whose whole value is that they
 * were read in ONE critical section must not be assemblable — or amendable —
 * field by field. Nothing accepts a caller-supplied snapshot today (both crash
 * entry points build their own), so this is parity with iOS's
 * `TXCapturedSession`, whose memberwise init is likewise `internal`, rather
 * than a reachable hole being closed.
 */
@ConsistentCopyVisibility
data class TXCapturedSession internal constructor(
    /** The user snapshot, with its own `startEpoch` and `resolve()`. */
    val user: TXCapturedUser,
    /**
     * The config installed at capture time; null before `start()`. EVERY
     * downstream routing decision must read this, never a live one.
     */
    val config: EverframeConfig?,
    /**
     * [Everframe] revocation counter as of the same critical section. Monotonic
     * and bumped ONLY by `kill()`, so a later `start()` cannot lower it back.
     */
    val killGeneration: Long,
    internal val captureConsent: Boolean = false,
) {
    /**
     * True once a `kill()` has landed since this snapshot was taken.
     *
     * Follow-ups item 9. The reporter's submit boundary lives in
     * `:everframe-reporter-ui`, a DIFFERENT Gradle module from the one
     * declaring [Everframe.killGenerationChanged] — which is `internal`, and
     * Kotlin `internal` does not cross module boundaries, so that function
     * is not merely inconvenient there, it is invisible. (iOS has the same
     * problem one step milder: `internal` there does not cross targets, and
     * its in-app reporter is its own target.)
     *
     * Exposed as a member on the snapshot rather than by widening
     * [Everframe.killGenerationChanged] itself: that function takes a bare
     * counter with no type safety, so a caller could compare against the
     * wrong generation and get a confidently wrong answer. As a member, the
     * only generation anyone can ask about is the one in their own snapshot.
     * Exactly the shape [TXCapturedUser.resolve] already uses to solve this
     * for the user half.
     *
     * A `val` with a getter, never a constructor property: this is DERIVED
     * from live state and must be re-evaluated at each read. Storing it would
     * freeze the answer at snapshot time, when it is always false.
     *
     * MONOTONIC, deliberately: a `start()` that re-opens `captureGate` after
     * the `kill()` must not un-revoke a capture taken before it. That is the
     * case a boolean gate check cannot express, and the reason
     * `_killGeneration` exists as a separate counter from `_startEpoch`.
     */
    val isRevoked: Boolean
        get() = Everframe.killGenerationChanged(killGeneration)

    /**
     * True once ANY `start()` or `kill()` has run since this snapshot was
     * taken — i.e. the session this report belongs to is no longer installed.
     *
     * Follow-ups item 9, second round (external review 2026-08-13, codex).
     * Routing by the captured config fixed the direction that mattered
     * (project A's report reaching project B) and opened a narrower one in
     * reverse: the submit paths pin A's key and then still read
     * PROCESS-GLOBAL buffers live — `sharedLogBuffer` and
     * `sharedNetworkBuffer` — well after the Send tap. A `start(B)` landing in
     * between means the rows they return were captured under B, and they would
     * ship under A's key.
     *
     * Not symmetrical with the buffers that are already safe: breadcrumbs and
     * network bodies are FROZEN at reporter-open (`takeFrozen()`), so they
     * cannot pick up B's content. Only the two live reads need this.
     *
     * Distinct from [isRevoked], which is about a `kill()` and stops the
     * report entirely. A superseding `start()` does not invalidate the report
     * — it was legitimately captured under A and still belongs to A — so the
     * caller DEGRADES it (drops what it cannot vouch for) instead of dropping
     * it. Same doctrine as [TXCapturedUser.resolve] returning null: lose data,
     * never misroute it.
     *
     * PLATFORM DIVERGENCE, deliberate: iOS's twin also compares a
     * `configGeneration`, and this one does not need to. iOS `start()` bumps
     * `_startEpoch` in one `stateLock` section and installs `_config` in a
     * second (its F39 ordering), so a snapshot can land between them holding
     * the NEW epoch beside the OLD config — a pairing the epoch alone would
     * later certify as current. Android's `start()` writes `_config`,
     * `captureGate` and `_startEpoch` inside ONE `stateLock.withLock` block,
     * so that mixed state cannot arise and the epoch is a complete answer
     * here. Found by external review on the iOS half, 2026-08-13; verified
     * against this file rather than assumed.
     */
    val isSuperseded: Boolean
        get() = Everframe.startEpochChanged(user.startEpoch)
}
