// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ONE decision, meant to be called from every submit path — live, drain and
// crash — so the rule cannot drift between them:
//
//   a token is attached to a report only when its `sub` equals the identity
//   the report was CAPTURED under.
//
// Every ambiguous case resolves to `null`, i.e. "send anonymously". Losing
// attribution is the failure this design nominates as acceptable; presenting
// one person's bearer credential on another person's report is not.
//
// Kotlin twin of packages/sdk-ios/Sources/Everframe/Identity/IdentityGate.swift
// — same four guards, same order, same fail-closed default at every branch.
package dev.everframe.identity

import dev.everframe.config.ReplayConfig
import dev.everframe.config.isIdentityEnabled

/**
 * The value for [IDENTITY_TOKEN_HEADER], or `null` to send anonymously.
 *
 * @param capturedSubject the identity recorded when the report was
 *   captured — `TXCapturedUser.identitySubject` on the live path,
 *   `OutboxEntry.identitySubject` on drain. `null` means the report was
 *   captured anonymously and can never be retroactively attributed.
 */
suspend fun resolveIdentityHeader(
    capturedSubject: String?,
    holder: IdentityTokenHolder,
    config: ReplayConfig,
    nowMs: Long,
): String? {
    // A project with no signing secret never presents a header at all.
    if (!isIdentityEnabled(config)) return null
    // Checked BEFORE touching the holder: an anonymous capture must not even
    // cause a provider to be invoked on its behalf.
    if (capturedSubject == null) return null
    val token = holder.get(nowMs) ?: return null
    if (decodeIdentityClaims(token)?.sub != capturedSubject) return null
    return token
}
