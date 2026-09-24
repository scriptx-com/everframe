// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ONE decision, meant to be called from every submit path — live, drain and
// crash — so the rule cannot drift between them:
//
//   a token is attached only when its `sub` equals the identity the report was
//   CAPTURED under.
//
// Every ambiguous case resolves to nil, i.e. "send anonymously". Losing
// attribution is the failure this design nominates as acceptable; presenting
// one person's bearer credential on another person's report is not.
import Foundation

/// The value for `X-Everframe-Identity-Token`, or `nil` to send anonymously.
///
/// - Parameter capturedSubject: the identity recorded when the report was
///   captured — `EFCapturedUser.identitySubject` on the live path,
///   `OutboxEntry.identitySubject` on drain. `nil` means the report was
///   captured anonymously and can never be retroactively attributed.
public func resolveIdentityHeader(
    capturedSubject: String?,
    holder: IdentityTokenHolder,
    config: ReplayConfig,
    now: Date
) async -> String? {
    // A project with no signing secret never presents a header at all.
    guard isIdentityEnabled(config) else { return nil }
    // Checked BEFORE touching the holder: an anonymous capture must not even
    // cause a provider to be invoked on its behalf.
    guard let capturedSubject else { return nil }
    guard let token = await holder.get(now: now) else { return nil }
    guard decodeIdentityClaims(token)?.sub == capturedSubject else { return nil }
    return token
}
