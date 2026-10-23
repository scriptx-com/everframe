// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. `CompanionState` stays, deprecated,
// until the next major so existing apps keep compiling.
// `Everframe.companion.state` is always `Unpaired`.

package dev.everframe.companion

/** State of the removed phone-companion flow. Always [Unpaired]. */
@Deprecated(COMPANION_REMOVED_MESSAGE)
enum class CompanionState {
    Unpaired,
    Paired,
    ReportInProgress,
    PhoneDisconnected,
}
