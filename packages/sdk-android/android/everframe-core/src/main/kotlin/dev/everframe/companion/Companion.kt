// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plan 06.2-08 — Companion observable state object.
//
// PATTERNS.md "Kotlin StateFlow + `__setX` indirection (Android)" — exact
// mirror of `Everframe.report.isPresenting` (Everframe.kt lines 285–308):
//   • `MutableStateFlow` private + `asStateFlow()` public read-only
//   • `__setX(value)` `@JvmStatic internal` seam, sole writer is RelayWSClient
//
// SECURITY: pair_token and device_token NEVER appear here — only the
// host-renderable pair_url (which already embeds pair_token, so it is
// printed once into the QR via the example app and otherwise lives in
// `_pairUrl` flow). Tokens themselves are kept inside the WS client.

package dev.everframe.companion

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object Companion {

    // ---------------- state ----------------

    private val _state = MutableStateFlow(CompanionState.Unpaired)

    /**
     * Current companion connection state.
     *
     * Hosts collect this on their Activity's `lifecycleScope` (per
     * plan-checker W2 — never GlobalScope) to render the QR/status panel.
     */
    @JvmStatic
    val state: StateFlow<CompanionState> = _state.asStateFlow()

    // ---------------- pairUrl ----------------

    private val _pairUrl = MutableStateFlow<String?>(null)

    /**
     * `https://{relay}/r/{pair_token}` — opaque shareable URL the host
     * encodes into a QR code. `null` when no pairing window is open.
     *
     * The relay's `pair.created` text frame is the sole producer (via
     * `RelayWSClient` + `__setPairUrl`); on `pair.bonded` / `pair.expired`
     * this MAY remain set or transition (see SPEC §State Machine).
     */
    @JvmStatic
    val pairUrl: StateFlow<String?> = _pairUrl.asStateFlow()

    // ---------------- code ----------------

    private val _code = MutableStateFlow<String?>(null)

    /**
     * Short human-readable display code for this device (spec 2026-08-07),
     * handed back by `POST /api/companion/announce` and rendered by the host
     * beside the QR. A dashboard user reads it off the TV to pick the right
     * row out of the project's device list.
     *
     * `null` whenever the device is not announced — no SDK key configured,
     * the announce failed (reporting still works; the device is simply
     * undiscoverable), or the pairing window closed. Shares [pairUrl]'s
     * lifecycle: cleared wherever [pairUrl] is.
     */
    @JvmStatic
    val code: StateFlow<String?> = _code.asStateFlow()

    // ---------------- attachedUserName ----------------

    private val _attachedUserName = MutableStateFlow<String?>(null)

    /**
     * Display name of the dashboard user currently attached to this device
     * (spec 2026-08-07), read off `pair.bonded.companion_user.display_name`.
     *
     * `null` on an ordinary QR bond — the field is absent there, and the
     * relay client resets this to null on every bond that does not carry it,
     * so a later QR pairing can never inherit a stale companion identity.
     */
    @JvmStatic
    val attachedUserName: StateFlow<String?> = _attachedUserName.asStateFlow()

    // ---------------- resolvedName ----------------

    private val _resolvedName = MutableStateFlow<String?>(null)

    /**
     * Server-resolved display name for this device (naming spec 2026-08-24):
     * a custom rename set from the dashboard, falling back to a host-supplied
     * label, falling back to a server-composed default derived from the
     * `device` block. Read off the announce response's `resolvedName` field
     * and live-updated by the `companion.name` relay frame, which the
     * dashboard triggers on a rename while this device stays connected.
     *
     * `null` whenever there is nothing resolved to show — no SDK key
     * configured, the announce failed (reporting still works; the device is
     * simply undiscoverable), the response omitted the field (older server)
     * or sent it blank, or the pairing window closed. Shares [code]'s
     * lifecycle: cleared wherever [code] is.
     *
     * Never a personal name: the SDK itself never reads or sends a raw
     * device name (e.g. a user-assigned "Aurimas's iPhone"-style string) —
     * this is a server-composed or explicitly-configured label only.
     */
    @JvmStatic
    val resolvedName: StateFlow<String?> = _resolvedName.asStateFlow()

    // ---------------- attachChallenge ----------------

    private val _attachChallenge = MutableStateFlow<AttachChallengeInfo?>(null)

    /**
     * Live attach-PIN challenge (spec 2026-08-19): a dashboard member is
     * asking to attach and this device must display [AttachChallengeInfo.code]
     * so they can type it into the dashboard. `null` whenever no challenge is
     * outstanding — no request in flight, the relay cleared it
     * (`attach.challenge.cleared`: expired/attached/burned/superseded), or the
     * pair itself ended (terminal socket close, same lifecycle as [code]).
     *
     * `:everframe-reporter-ui`'s `CompanionPinPresenter` collects this to
     * render the built-in dialog; a host running `AttachPinUi.CUSTOM` collects
     * it directly to render its own UI. SECURITY: the code is meant for the
     * device's own screen — never log it (see `RelayWSClient` call sites).
     */
    @JvmStatic
    val attachChallenge: StateFlow<AttachChallengeInfo?> = _attachChallenge.asStateFlow()

    // ---------------- Internal seams (sole writers: RelayWSClient + tests) ----------------
    //
    // Mirrors `Everframe.report.__setPresenting` — `@JvmStatic internal` so
    // cross-language callers (Java sample app, Kotlin tests) can flip
    // state without expanding the public API. Plan-checker single-writer
    // audit greps for `__setState`/`__setPairUrl` writers — only
    // `RelayWSClient.kt` and `companion/*Test.kt` may match. The report seams
    // below (`__beginReport` / `__finishReport`) are the exception the audit
    // has to know about: `CompanionCaptureBridge.kt` ends the reports it
    // submits, and it must go through them rather than `__setState`.

    /**
     * Sole `state` writer for everything except the report lifecycle, which
     * goes through [__beginReport] / [__finishReport] because it carries an
     * identity.
     *
     * Every state other than `ReportInProgress` RELEASES the running report's
     * claim, which is what keeps the invariant "a report owns
     * `ReportInProgress` for exactly as long as the pair is in it" true. A
     * terminal close (`Unpaired`), a backgrounding (`PhoneDisconnected`) or a
     * re-bond (`Paired`) all end that claim, and a completion arriving
     * afterwards must not resurrect `Paired` on top of whatever came next.
     */
    @JvmStatic
    internal fun __setState(value: CompanionState) {
        if (value != CompanionState.ReportInProgress) {
            synchronized(reportLock) { reportInProgressCorrelationId = null }
        }
        _state.value = value
    }

    // ---------------- Report ownership (PR-fix 7) ----------------

    /**
     * The `correlation_id` of the report that currently OWNS
     * `ReportInProgress`, or null when no report does.
     *
     * `state` alone cannot answer "may this completion clear the report?". The
     * pair can re-bond to a different dashboard user while an upload is still
     * running (`releasePairBond` force-closes only the phone leg, so the same
     * TV socket and the same client serve both): that bond flips the shared
     * state back to `Paired`, the new user's `report.request` is accepted and
     * re-enters `ReportInProgress`, and the OLD upload then finished and — in
     * `launchSubmit`, before this field existed — flipped the state to `Paired`
     * unconditionally. A third request was then accepted over the second,
     * re-freezing the replay snapshot the second report's composer was about to
     * consume.
     *
     * The identity is the correlation_id and not the bond/connect generation:
     * correlation_id names the REPORT, which is what a completion is a
     * completion OF. A generation is coarser — two reports run in sequence
     * under one bond, so a stale completion from the first would still match
     * the second's generation and clear it.
     *
     * Mirrors iOS `CompanionAPI.reportInProgressCorrelationId`.
     */
    private val reportLock = Any()
    private var reportInProgressCorrelationId: String? = null

    /**
     * Enter `ReportInProgress` on behalf of [correlationId], which from here
     * until a matching [__finishReport] is the sole owner of that state.
     */
    @JvmStatic
    internal fun __beginReport(correlationId: String) {
        synchronized(reportLock) { reportInProgressCorrelationId = correlationId }
        _state.value = CompanionState.ReportInProgress
    }

    /**
     * Return to `Paired` — but ONLY if [correlationId] is the report that
     * currently owns `ReportInProgress`. Returns whether it did.
     *
     * [beforePaired] runs under the same claim, immediately before the flip,
     * and ONLY when the claim succeeds. That is where a caller puts work which
     * touches shared capture state (the replay discard on the cancel path):
     * running it for a superseded report throws away the LIVE report's frozen
     * snapshot, which is the same defect as clearing its state.
     *
     * The state test alongside the id is implied by [__setState]'s release — a
     * non-null claim means the pair is in `ReportInProgress` — and is written
     * out anyway because that invariant lives in a different method, and
     * because "return to `Paired` only from `ReportInProgress`" is the property
     * this method is named for.
     */
    /**
     * Fired for EVERY report that ends, before the ownership check below.
     *
     * `RelayWSClient` installs this to drop that report's shot stash. It has to
     * live here rather than on the client's own `send()` because
     * `CompanionCaptureBridge` writes its terminal `report.completed` /
     * `report.failed` frames straight onto the raw WebSocket, bypassing the
     * client entirely — so hooking the client's send left up to eight
     * report-grade screenshots of the user's screen resident after a perfectly
     * normal successful submit.
     *
     * Fired even when the ownership check fails: a superseded report is still
     * over, and its captures should go. The callback is correlation-scoped, so
     * it cannot drop a newer live report's stash.
     */
    @JvmStatic
    internal var __onReportEnded: ((String) -> Unit)? = null

    @JvmStatic
    internal fun __finishReport(
        correlationId: String,
        beforePaired: () -> Unit = {},
    ): Boolean = synchronized(reportLock) {
        __onReportEnded?.invoke(correlationId)
        if (_state.value != CompanionState.ReportInProgress ||
            reportInProgressCorrelationId != correlationId
        ) {
            return false
        }
        reportInProgressCorrelationId = null
        beforePaired()
        _state.value = CompanionState.Paired
        return true
    }

    /** Test seam — which report, if any, owns `ReportInProgress` right now. */
    @JvmStatic
    internal fun __reportInProgressCorrelationIdForTesting(): String? =
        synchronized(reportLock) { reportInProgressCorrelationId }

    @JvmStatic
    internal fun __setPairUrl(value: String?) {
        _pairUrl.value = value
    }

    @JvmStatic
    internal fun __setCode(value: String?) {
        _code.value = value
    }

    @JvmStatic
    internal fun __setAttachedUserName(value: String?) {
        _attachedUserName.value = value
    }

    @JvmStatic
    internal fun __setResolvedName(value: String?) {
        _resolvedName.value = value
    }

    @JvmStatic
    internal fun __setAttachChallenge(value: AttachChallengeInfo?) {
        _attachChallenge.value = value
    }
}

/**
 * Display shape of a live attach-PIN challenge (spec 2026-08-19), decoded off
 * an `attach.challenge` relay frame. SECURITY: [code] is a short-lived
 * on-device display credential — never log it.
 */
data class AttachChallengeInfo(
    val code: String,
    val requestedByName: String,
    val ttlMs: Long,
)
