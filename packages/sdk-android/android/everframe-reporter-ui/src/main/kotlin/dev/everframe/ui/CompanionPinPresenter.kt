// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Built-in attach-PIN surface (spec 2026-08-19). Collects
// Companion.attachChallenge and shows a passive dialog over the
// currently-resumed Activity — no buttons; reading the code to the dashboard
// IS the consent. If no Activity is resumed when a challenge lands
// (backgrounded app), the challenge is held and presented on the next
// resume, still gated on the flow's CURRENT value so an expired/cleared
// challenge never pops late.
//
// `:everframe-reporter-ui` declares no `res/values/strings.xml` (checked —
// every other file in this module uses inline literals, not `R.string`), so
// this file follows suit rather than introducing the module's first
// resource file for two short strings.
package dev.everframe.ui

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Typeface
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import dev.everframe.Everframe
import dev.everframe.companion.AttachChallengeInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal object CompanionPinPresenter {
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var dialog: AlertDialog? = null
    private var installed = false
    private var expiryJob: Job? = null

    // Stale re-present fix (spec 2026-08-19 review finding 2). [onActivityResumed]
    // re-presents from the flow's CURRENT value, which is the SAME
    // [AttachChallengeInfo] instance the collector below already presented —
    // re-arming [present] with a fresh full `challenge.ttlMs` on every resume
    // would let the on-device dialog outlive its real expiry indefinitely
    // (each resume resets the clock). The fix: compute an ABSOLUTE deadline
    // once, the moment a given challenge is first observed, and always arm
    // the expiry job against the REMAINING time to that deadline — never a
    // fresh full ttlMs on a re-present. A single field suffices (not a map):
    // `Companion.attachChallenge` is a `StateFlow<AttachChallengeInfo?>`, so
    // at most one challenge is ever live at a time. Keyed by structural
    // equality of the whole [AttachChallengeInfo] (not just `code`) so a
    // genuinely NEW challenge that happens to reuse the same code (distinct
    // `ttlMs`/`requestedByName`) is correctly treated as new, not stale.
    private var trackedChallenge: AttachChallengeInfo? = null
    private var trackedDeadlineElapsedRealtime: Long = 0L

    fun install() {
        if (installed) return
        installed = true
        Everframe.__attachPinUiInstalled = true
        scope.launch {
            dev.everframe.companion.Companion.attachChallenge.collect { challenge ->
                if (challenge == null) {
                    trackedChallenge = null
                    dismiss()
                } else {
                    if (challenge != trackedChallenge) {
                        // Genuinely new challenge (first sighting) — this is
                        // the ONE place a full `ttlMs` window is minted.
                        trackedChallenge = challenge
                        trackedDeadlineElapsedRealtime =
                            android.os.SystemClock.elapsedRealtime() + challenge.ttlMs
                    }
                    present(challenge, trackedDeadlineElapsedRealtime)
                }
            }
        }
    }

    /** Re-check on foreground: ActivityRegistry calls this from onActivityResumed. */
    fun onActivityResumed() {
        val challenge = dev.everframe.companion.Companion.attachChallenge.value
        if (challenge == null || dialog != null) return
        // The ordinary case: this IS the challenge the collector above
        // already tracked — reuse its recorded deadline so a re-present on
        // resume dismisses at the SAME wall-clock moment the original
        // `present` would have, not a fresh `ttlMs` later.
        val deadline = if (challenge == trackedChallenge) {
            trackedDeadlineElapsedRealtime
        } else {
            // Defensive only: the flow changed underneath us without the
            // collector observing it first (collector and this function both
            // read the same StateFlow, so this should not happen in
            // practice) — treat it as a fresh sighting rather than presenting
            // against a stale/zero deadline.
            trackedChallenge = challenge
            (android.os.SystemClock.elapsedRealtime() + challenge.ttlMs)
                .also { trackedDeadlineElapsedRealtime = it }
        }
        present(challenge, deadline)
    }

    /**
     * An `AlertDialog` leaks if its Activity finishes underneath it.
     * `ActivityRegistry.onActivityPaused`/`onActivityDestroyed` call this
     * when clearing `current` — the challenge stays in the flow, so the next
     * resume ([onActivityResumed]) re-presents it against whatever Activity
     * comes back.
     */
    fun onActivityGone() {
        dismiss()
    }

    private fun present(challenge: AttachChallengeInfo, deadlineElapsedRealtime: Long) {
        // Suppressed by the host (RN bridge / other native hosts) when the
        // configured attach-PIN mode is not `builtin` — something else owns
        // rendering. The StateFlow itself is untouched; a custom UI still
        // collects it directly. `dismiss()` still runs so a dialog shown
        // before suppression flipped on doesn't linger (matches iOS).
        if (Everframe.__attachPinUiSuppressed) {
            dismiss()
            return
        }
        dismiss()
        // Local expiry: the server's cleared/expired frame rides the sweeper
        // (60s tick) — hide at the deadline locally so a dead code never
        // lingers. ALWAYS the remaining time to the tracked absolute
        // deadline, never a fresh full `challenge.ttlMs` — see the class-level
        // comment on `trackedDeadlineElapsedRealtime` for why a re-present on
        // resume must not reset this clock.
        val remaining = deadlineElapsedRealtime - android.os.SystemClock.elapsedRealtime()
        if (remaining <= 0) {
            // Already past its deadline (e.g. resumed long after the original
            // ttlMs window closed) — never show a code that's already dead.
            return
        }
        expiryJob?.cancel()
        expiryJob = scope.launch {
            delay(remaining)
            dismiss()
        }
        val activity: Activity = ActivityRegistry.activeActivity() ?: return // onActivityResumed retries
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(48, 40, 48, 40)
            addView(
                TextView(activity).apply {
                    text = "${challenge.requestedByName} wants to connect"
                    textSize = 14f
                },
            )
            addView(
                TextView(activity).apply {
                    // SECURITY: challenge.code is never logged anywhere in this
                    // class — display on-device IS the feature, logcat is not
                    // the device screen.
                    text = challenge.code
                    textSize = 40f
                    typeface = Typeface.MONOSPACE
                    letterSpacing = 0.3f
                },
            )
            addView(
                TextView(activity).apply {
                    text = "Enter this code in the Everframe dashboard"
                    textSize = 12f
                },
            )
        }
        dialog = AlertDialog.Builder(activity)
            .setView(content)
            .setCancelable(false) // dismissal is server-driven (cleared/expiry), not a tap
            .create()
            .also { it.show() }
    }

    private fun dismiss() {
        expiryJob?.cancel()
        expiryJob = null
        dialog?.let { runCatching { it.dismiss() } }
        dialog = null
    }
}
