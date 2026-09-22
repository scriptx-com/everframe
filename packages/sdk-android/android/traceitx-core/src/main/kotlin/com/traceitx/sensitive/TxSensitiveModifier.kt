// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `Modifier.txSensitive()` — public Compose API. Hooks the Compose Semantics
// tree with TX_SENSITIVE_KEY=true; the Compose walkers (SensitiveRectRegistry
// for screenshot blackout, NativeVideoPrivacyGate for video exclusion) read this
// to mark the SemanticsNode as sensitive (no descent into children, baked black
// pre-encode in the screenshot).
//
// Mirrors PRIV-03 invariant from iOS analog (UIView+Sensitive.swift) — Compose
// idiom uses Semantics rather than a property extension. mergePolicy and
// `mergeDescendants = true` ensure that wrapping a subtree marks the entire
// subtree as sensitive even if intermediate nodes don't carry the key.

package com.traceitx.sensitive

import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics

/** Custom SemanticsPropertyKey marking a Composable subtree as sensitive.
 *  Default mergePolicy keeps parent value if present; "sensitive" is sticky
 *  going up the tree because we set `mergeDescendants = true` at the txSensitive
 *  Modifier site, which collapses descendants into the parent's config. */
public val TX_SENSITIVE_KEY: SemanticsPropertyKey<Boolean> =
    SemanticsPropertyKey(name = "traceitx.sensitive")

/**
 * Mark a Compose subtree as sensitive. The screenshot capture pipeline bakes
 * black over this region BEFORE PNG encode (PRIV-03), and the UI-tree walker
 * emits the subtree as a sensitive leaf.
 */
public fun Modifier.txSensitive(): Modifier =
    this.semantics(mergeDescendants = true) {
        this[TX_SENSITIVE_KEY] = true
    }
