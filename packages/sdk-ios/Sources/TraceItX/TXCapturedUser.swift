// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding 1 (Serious) — a user captured at the Send tap could
// still be uploaded under a DIFFERENT project's SDK key.
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
// But the SDK CONFIGURATION — which carries the API key and therefore the
// project every byte is uploaded to — is still read later, inside the
// asynchronous submission (`ReporterSubmission.submit`'s `currentConfig`
// guard). Those two reads are not atomic, so:
//
//     setUser(A) → [Send tap: snapshot A] → start(projectB) → submit reads
//     project B's config → A's id/email/display name uploaded under B's key
//
// creates a falsely attributed person in a different customer's project. The
// `start()`-clears-the-user fix is precisely what makes the SURVIVING captured
// value dangerous: the live singleton is clean, the snapshot is not.
//
// The remedy is to make a captured user valid only for the session it was
// captured in, using the mechanism this SDK already has for exactly this class
// of bug: `TraceItX._startEpoch`, a monotonically increasing generation counter
// bumped under `stateLock` by BOTH `start()` and `kill()` (see its doc comment
// for the full rationale, and `ReplaySession.startEpochAtCreation` for the
// established precedent of capturing it and re-checking it later). Capturing
// the user and the epoch in ONE `stateLock` critical section makes the pair
// atomic; re-checking the epoch at submit time discards the snapshot the
// instant a superseding `start()`/`kill()` has run.
//
// Degrading to anonymous is the correct failure mode: recognition must never
// fail or delay a report, and losing attribution is always preferable to
// attributing to the wrong person or — as here — the wrong project.
import Foundation

/// A self-declared user (`setUser`, spec 2026-08-12) snapshotted at a submit
/// boundary, TOGETHER with the SDK session it was snapshotted in AND the
/// verified-identity subject (recognition spec 2026-08-06) active at that same
/// instant.
///
/// Construct only via `TraceItX.shared.captureUserSnapshot()` — the memberwise
/// initializer is deliberately internal so the three fields can never be
/// captured separately (a user read at one instant, an epoch read at another
/// and a subject read at a third is the exact non-atomicity this type exists
/// to remove — reading any pair of the three apart from the third reopens the
/// same hazard `startEpoch` was added to close).
///
/// `TXUser` is a value type, so the captured user is a snapshot by
/// construction; nothing can mutate it after the fact.
public struct TXCapturedUser {
    /// The user that was installed when this snapshot was taken. `nil` when no
    /// `setUser` had been called (the ordinary anonymous case).
    public let user: TXUser?

    /// `TraceItX._startEpoch` as of the same `stateLock` critical section that
    /// read `user`. Compared against the live epoch by `resolve()`.
    public let startEpoch: Int

    /// The verified-identity `sub` this report was CAPTURED under — read from
    /// `IdentityTokenHolder.cachedSubject(now:)` in the same `stateLock`
    /// critical section as `user`/`startEpoch`. `nil` when no identity token
    /// was cached and presentable at capture time (no host-set token, an
    /// expired/stale one, or a cold cache — capture is synchronous and must
    /// never block on a provider, so a cold cache stamps the report
    /// anonymous). `resolveIdentityHeader` compares this against whatever
    /// identity is active at submit time and withholds the header on any
    /// mismatch, exactly like `resolve()` does for `user`/`startEpoch`.
    public let identitySubject: String?

    internal init(user: TXUser?, startEpoch: Int, identitySubject: String?) {
        self.user = user
        self.startEpoch = startEpoch
        self.identitySubject = identitySubject
    }

    /// The captured user, or `nil` if the session it was captured in is no
    /// longer the installed one — i.e. a `start()` (possibly with a different
    /// project's SDK key) or a `kill()` has run since the capture.
    ///
    /// Call this at the point the envelope is assembled, AFTER the config that
    /// will carry the upload has been read. That ordering is what makes the
    /// pair safe without a single lock spanning both: the epoch increases
    /// monotonically, so an epoch that still matches here proves no
    /// `start()`/`kill()` ran at any point between the capture and this call —
    /// including the moment the config was read, which is therefore this same
    /// session's config.
    ///
    /// Never throws, never blocks on anything but the short `stateLock`.
    public func resolve() -> TXUser? {
        TraceItX.shared.resolveCapturedUser(self)
    }
}

/// The whole session a crash was captured under, read in ONE `stateLock`
/// critical section.
///
/// `TXCapturedUser` fixed half of this: the user could no longer be paired
/// with a session it did not belong to. The config was still read separately,
/// a few statements later — so a `start(projectB)` landing in that window
/// built project A's crash and stamped it with B's key (follow-ups item 6).
/// Capturing the config alongside the user removes the second read entirely,
/// which is why routing no longer depends on what the epoch says.
///
/// Wraps `TXCapturedUser` rather than flattening it, so `resolve()` and its
/// epoch rule stay exactly where they were.
///
/// **Atomic in the READ, not in the write.** The three fields are read in one
/// `stateLock` acquisition, but `start()` writes them in TWO: `_startEpoch` and
/// `_user = nil` in the first section, `_config` and `captureGate` in the
/// second (see `TraceItX.start(config:)` — the user clear had to move ahead of
/// the buffer resets, round-8 Finding F39). A snapshot landing between those
/// two sections therefore returns `config = A`, `startEpoch = B`, `user = nil`.
/// That combination is harmless and in fact correct: the crash is stamped for
/// project A, which is where it happened, and it ships anonymously — exactly
/// the row the design intends for a crash that straddles `start(B)`. The
/// invariant this type guarantees is that the config a report is ROUTED by and
/// the user it is ATTRIBUTED to were never taken from two different sessions;
/// it is not a claim that `start()` installs a whole session atomically.
public struct TXCapturedSession {
    /// The user snapshot, with its own `startEpoch` and `resolve()`.
    public let user: TXCapturedUser

    /// The config installed at capture time. `nil` before `start()`.
    /// EVERY downstream routing decision must read this, never a live one.
    public let config: TraceItXConfig?

    /// `TraceItX._killGeneration` as of the same critical section. Monotonic
    /// and bumped ONLY by `kill()`, so a later `start()` cannot lower it back.
    public let killGeneration: UInt64

    /// `TraceItX._configGeneration` as of the same critical section — the
    /// counter bumped in lock-step with `_config` itself. See `isSuperseded`.
    public let configGeneration: UInt64

    /// True once a `kill()` has landed since this snapshot was taken.
    ///
    /// Follow-ups item 9. The submit boundaries need this check from
    /// `TraceItXReporterUI`, a DIFFERENT target from the one declaring
    /// `TraceItX.killGenerationChanged` — which is `internal`, and Swift
    /// `internal` does not cross targets, so that function is invisible there.
    /// (Android has the identical problem one step worse: its reporter is a
    /// separate Gradle module, and Kotlin `internal` does not cross those
    /// either.)
    ///
    /// Exposed as a member on the snapshot rather than by widening
    /// `killGenerationChanged` itself: that function takes a bare counter with
    /// no type safety, so a caller could compare against the wrong generation
    /// and get a confidently wrong answer. Keeping it a member means the only
    /// generation any caller can ask about is the one in its own snapshot.
    /// Exactly the shape `resolve()` above already uses to solve this for the
    /// user half.
    ///
    /// MONOTONIC, deliberately: a `start()` that re-opens `captureGate` after
    /// the `kill()` must not un-revoke a capture taken before it. That is the
    /// case a boolean gate check cannot express, and the reason
    /// `_killGeneration` exists as a separate counter from `_startEpoch`.
    public var isRevoked: Bool {
        TraceItX.killGenerationChanged(since: killGeneration)
    }

    /// True once ANY `start()` or `kill()` has run since this snapshot was
    /// taken — i.e. the session this report belongs to is no longer the
    /// installed one.
    ///
    /// Follow-ups item 9, second round (external review 2026-08-13, codex).
    /// Routing by the captured config fixed the direction that mattered
    /// (project A's report reaching project B) and opened a narrower one in
    /// reverse: the submit paths pin A's key and then still read
    /// PROCESS-GLOBAL buffers live — `LogRingBuffer` and `NetworkRingBuffer`
    /// — several statements later. A `start(B)` landing between the Send tap
    /// and those reads means the rows they return were captured under B, and
    /// they would ship under A's key.
    ///
    /// Narrow but real, and NOT symmetrical with the buffers that are already
    /// safe: breadcrumbs and network bodies are FROZEN at reporter-open
    /// (`takeFrozen()`), so they cannot pick up B's content at all. Only the
    /// two live reads need this.
    ///
    /// Distinct from `isRevoked`, which is about a `kill()` only and stops the
    /// report entirely. A superseding `start()` does not invalidate the
    /// report — it was legitimately captured under A and still belongs to A —
    /// so the caller DEGRADES it (drops the sections it can no longer vouch
    /// for) rather than dropping it. Same doctrine as `resolve()` returning
    /// `nil`: lose data, never misroute it.
    public var isSuperseded: Bool {
        // TWO counters, deliberately, and the config one is not redundant.
        //
        // Fourth round (external review 2026-08-13, codex). The epoch alone
        // can certify a MIXED session as current on iOS. `start()` bumps
        // `_startEpoch` in its first critical section and installs `_config`
        // in a second one (F39's ordering — see `_configGeneration`), so a
        // snapshot landing between them holds the NEW epoch beside the OLD
        // config. Once `start()` finishes, the epoch matches, and an
        // epoch-only check would report "intact" for a report that is pinned
        // to a stale config — letting the submit paths accept the NEW
        // session's live and frozen buffers while routing by the OLD
        // session's key. Exactly the reverse disclosure this whole item is
        // about, reintroduced through the guard meant to prevent it.
        //
        // `configGeneration` closes it because it is bumped in lock-step with
        // `_config` itself: "my pinned config is still the installed one" is
        // then a fact about the same write, not an inference from a
        // neighbouring one.
        //
        // The epoch check stays as well, because it catches what the config
        // counter cannot: iOS `kill()` does NOT clear `_config` (unlike
        // Android's), so after a kill the config generation is unchanged while
        // the epoch has moved.
        TraceItX.configGenerationChanged(since: configGeneration)
            || user.startEpoch != TraceItX.shared.currentStartEpoch
    }

    internal init(
        user: TXCapturedUser,
        config: TraceItXConfig?,
        killGeneration: UInt64,
        configGeneration: UInt64
    ) {
        self.user = user
        self.config = config
        self.killGeneration = killGeneration
        self.configGeneration = configGeneration
    }
}
