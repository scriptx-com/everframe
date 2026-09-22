// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure shot-list operations for the multi-screenshot strip. Compose-free so
// the web-QA-locked branching (delete confirm, neighbor selection, add-tile
// cap) is unit-testable under plain JUnit.
//
// Kotlin port of packages/sdk-ios/Sources/TraceItXReporterUI/Annotation/ShotListOps.swift
// (Android Task 7 — multi-shot state + strip).
package com.traceitx.ui.annotation

object ShotListOps {
    const val MAX_SHOTS: Int = 5

    /** Confirm before deleting ONLY when the shot has annotations (web QA lock). */
    fun deleteNeedsConfirmation(annotationCount: Int): Boolean = annotationCount > 0

    /** Result of removing the shot at [index] from a list of [count] shots. */
    data class DeleteOutcome(
        /** null when the list becomes empty. */
        val newActiveIndex: Int?,
    )

    /** Neighbor selection: min(index, newCount - 1); deleting all is allowed. */
    fun delete(at: Int, count: Int): DeleteOutcome =
        DeleteOutcome(newActiveIndex = (count - 1).let { if (it > 0) minOf(at, it - 1) else null })

    /** Add tile is HIDDEN (not disabled) at the cap. */
    fun showsAddTile(count: Int): Boolean = count < MAX_SHOTS
}
