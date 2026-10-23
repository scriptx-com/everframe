// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. `Companion` stays, deprecated, until
// the next major so apps that collect `Everframe.companion` keep compiling.
// Every flow holds its idle value forever: `state` is `Unpaired`, everything
// else is `null`.
@file:Suppress("DEPRECATION")

package dev.everframe.companion

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The removed Companion observation surface. Every value is idle. */
@Deprecated(COMPANION_REMOVED_MESSAGE)
object Companion {
    /** Always [CompanionState.Unpaired]. */
    @JvmStatic
    val state: StateFlow<CompanionState> = MutableStateFlow(CompanionState.Unpaired).asStateFlow()

    /** Always `null`. */
    @JvmStatic
    val pairUrl: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()

    /** Always `null`. */
    @JvmStatic
    val code: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()

    /** Always `null`. */
    @JvmStatic
    val attachedUserName: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()

    /** Always `null`. */
    @JvmStatic
    val resolvedName: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()

    /** Always `null`. */
    @JvmStatic
    val attachChallenge: StateFlow<AttachChallengeInfo?> = MutableStateFlow<AttachChallengeInfo?>(null).asStateFlow()
}

/** A dashboard-initiated attach request from the removed Companion flow. Nothing produces one. */
@Deprecated(COMPANION_REMOVED_MESSAGE)
data class AttachChallengeInfo(
    val code: String,
    val requestedByName: String,
    val ttlMs: Long,
)
