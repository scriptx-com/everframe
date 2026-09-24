// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The (non-secret) install identifier this Everframe SDK reports on
// `GET /api/config?installId=<value>` for MAI ("monthly active install")
// metering — a display-only, per-(org, month) distinct-install count. This is
// NOT a user identifier and NOT authentication; never call it a "user id" or
// reason about it as one. One person with a phone, a tablet and the web app is
// three installs and one user.
//
// WHY NOT `DeviceKey`. The spec originally had this derive from
// `Outbox/DeviceKey.swift`, on the premise that reusing it needed no new
// storage. That premise was false: `DeviceKey` has no production call site on
// this platform (or on Android) — nothing mints it. Reusing it would have
// meant STARTING to write a Keychain item on every install for a display-only
// meter, acquiring its failure paths (its `precondition` on a CSPRNG failure
// crashes the host), its launch cost, and the unsigned-macOS-host probe dance
// that is this repo's documented false-green hazard. So this mints its own
// non-secret seed instead, symmetric with web. See the spec's Counting
// architecture section, second amendment 2026-08-28.
//
// STORAGE. `UserDefaults`, not the Keychain, and deliberately so: this value
// authenticates nothing. A backup/restore carries it to the new device, which
// under-counts by one install — the safe direction for a number a customer is
// billed on later, and the same semantics web has when a browser profile is
// copied.
//
// NOT SCOPED ON THE Everframe SDK KEY, unlike web. Web scopes its storage key on the
// api key because one ORIGIN can host two apps with different keys, and that
// scoping is what prevents cross-org correlation there. This store is
// app-sandboxed, so scoping would buy no privacy — and it would re-mint every
// install identity on Everframe SDK-key rotation, which is already a known inflation
// defect on web (up to 2x in a rotation month, from an operation we actively
// encourage). Do not "restore symmetry" here.
//
// CONSTRUCTION. HMAC-SHA256(key = seed, message = domain separator), then
// unpadded base64url. The seed is the KEY, not the message: HMAC's PRF
// guarantee over the key is exactly what makes the seed unrecoverable from any
// number of outputs, even for a fixed, publicly-known message. Keying on the
// domain separator instead would not carry that guarantee. Byte-identical with
// `deriveInstallId` in packages/sdk-core/src/install-id.ts; the shared vector
// in Tests/EverframeTests/Fixtures/install-id.v1.json is what proves it.
//
// NO READ-BACK, UNLIKE WEB. Web's `getOrCreateInstallSeed`
// (packages/sdk-react/src/reporter/credential-store.ts:207-217) reads its own
// `localStorage` write back immediately after minting, because several
// browser tabs can each reach an empty store concurrently and, without that
// read-back, each would keep its own freshly-minted seed for the tab's whole
// lifetime — the reviewer measured multiple seeds in 90 of 100 rounds of a
// 20-tab probe. `getOrCreateSeed` below is plain check-then-act with no such
// read-back, which is correct for the single-process-per-storage-domain case
// this Everframe SDK assumes: one app, one `UserDefaults.standard`. That assumption is
// not universal, though — an iOS app extension (widget, share sheet, etc.)
// has its OWN `UserDefaults.standard` domain, separate from its host app's,
// so a user who triggers both would mint two seeds for what is really one
// install, permanently (there is no shared "last writer wins" store across
// domains for a read-back to converge on, unlike web's single origin). This
// is documented, not mitigated — see the review that introduced this note.
import CryptoKit
import Foundation
import Security

enum InstallIdentifier {
    /// Versioned so a future change to this derivation can bump to "-v2" and
    /// produce values unambiguously distinct from anything derived under v1.
    /// Must equal `INSTALL_ID_DOMAIN_SEPARATOR` in sdk-core.
    static let domainSeparator = "everframe-install-id-v1"

    /// 16 bytes -> 32 lowercase hex. Plenty of distinctness for a metering
    /// seed; there is no secrecy requirement here to justify more. Same width
    /// web uses (`INSTALL_SEED_BYTES`).
    static let seedBytes = 16

    static let defaultsKey = "dev.everframe.installSeed"

    static let defaultsDayKey = "dev.everframe.installIdDay"

    /// UTC day number — whole days since the epoch. Deliberately arithmetic
    /// rather than `DateFormatter`/`Calendar`: web and Android run the
    /// identical expression, and three separate "what day is it in UTC"
    /// implementations would be three chances to disagree in a way no
    /// single-platform test could catch (each platform still dedupes correctly
    /// against its OWN past either way).
    static func utcDayNumber(_ date: Date) -> Int {
        Int(floor(date.timeIntervalSince1970 / 86_400))
    }

    /// The supplier handed to `ReplayConfigProvider` (MAI meter spec
    /// 2026-08-27, D3). Yields the identifier at most once per install per UTC
    /// day; every other call yields nil, which the provider treats as "send the
    /// config URL unchanged".
    ///
    /// The day is recorded at HAND-OVER — on dispatch, not on a successful
    /// response. Recording on success would re-send through every failed
    /// fetch, and a lost day costs nothing: the server deduplicates per
    /// calendar MONTH, so any later day in that month still counts this
    /// install. For the same reason nothing here retries.
    ///
    /// `enabled: false` (the client veto) returns a supplier that computes
    /// nothing, stores nothing, and yields nothing — not one that derives and
    /// discards.
    ///
    /// Never throws.
    static func makeSupplier(
        enabled: Bool,
        defaults: UserDefaults = .standard,
        now: @escaping @Sendable () -> Date = { Date() }
    ) -> @Sendable () -> String? {
        guard enabled else { return { nil } }
        // `UserDefaults` is documented thread-safe but Foundation does not mark
        // it `Sendable`, and this package builds with
        // `StrictConcurrency=complete` (Package.swift:42) — so capturing it
        // directly in the `@Sendable` closure the provider stores is a
        // compile error. `nonisolated(unsafe)` asserts the safety Apple
        // already documents for `UserDefaults`; this file has no prior use of
        // the pattern to point at, so this comment stands on that
        // documented-safety argument alone rather than an in-repo precedent.
        nonisolated(unsafe) let store = defaults
        return {
            let today = utcDayNumber(now())
            // A malformed or absent marker is treated as "not sent today"
            // rather than trusted: over-sending is free (the server's unique
            // constraint absorbs it), while trusting garbage could suppress an
            // install for a whole month.
            if let stored = store.string(forKey: defaultsDayKey),
               let storedDay = Int(stored),
               storedDay == today {
                return nil
            }
            guard let id = current(defaults: store) else { return nil }
            store.set(String(today), forKey: defaultsDayKey)
            return id
        }
    }

    /// The value the config read carries, or `nil` when anything at all went
    /// wrong. NEVER throws and never crashes: the caller bakes this into the
    /// config URL, and that read is the Everframe SDK's remote kill switch. An uncounted
    /// install is cosmetic; a config fetch that never fires is not.
    static func current(defaults: UserDefaults = .standard) -> String? {
        guard let seed = getOrCreateSeed(defaults: defaults) else { return nil }
        return derive(seed: seed)
    }

    static func derive(seed: Data) -> String {
        let mac = HMAC<SHA256>.authenticationCode(
            for: Data(domainSeparator.utf8),
            using: SymmetricKey(data: seed)
        )
        return base64urlUnpadded(Data(mac))
    }

    /// Foundation emits the STANDARD alphabet with padding; the wire contract
    /// (and the server's `/^[A-Za-z0-9_-]{22,86}$/`) needs base64url without
    /// it. The all-zero-seed vector case is what catches a regression here.
    static func base64urlUnpadded(_ data: Data) -> String {
        var s = data.base64EncodedString()
        s = s.replacingOccurrences(of: "+", with: "-")
        s = s.replacingOccurrences(of: "/", with: "_")
        while s.hasSuffix("=") { s.removeLast() }
        return s
    }

    static func getOrCreateSeed(defaults: UserDefaults = .standard) -> Data? {
        if let stored = defaults.string(forKey: defaultsKey), let bytes = decodeSeedHex(stored) {
            return bytes
        }
        var fresh = Data(count: seedBytes)
        let status = fresh.withUnsafeMutableBytes { ptr -> Int32 in
            guard let base = ptr.baseAddress else { return errSecAllocate }
            return SecRandomCopyBytes(kSecRandomDefault, seedBytes, base)
        }
        // Deliberate contrast with `DeviceKey.getOrCreate`, which
        // `precondition`s here: that value authenticates real requests, so a
        // silent weak key would be a security defect worth crashing over. This
        // one authenticates nothing — a CSPRNG failure costs one uncounted
        // install, and must never take down the host app.
        guard status == errSecSuccess else { return nil }
        defaults.set(encodeSeedHex(fresh), forKey: defaultsKey)
        return fresh
    }

    /// Exactly `/^[0-9a-f]{32}$/`, matching web's `INSTALL_SEED_HEX_RE`. A
    /// stored value of any other shape is DISCARDED and re-minted rather than
    /// used — same posture as web, and as `isWellFormedDeviceToken` for the
    /// device token.
    static func decodeSeedHex(_ hex: String) -> Data? {
        guard hex.count == seedBytes * 2 else { return nil }
        var out = Data(capacity: seedBytes)
        var idx = hex.startIndex
        while idx < hex.endIndex {
            let next = hex.index(idx, offsetBy: 2)
            guard let byte = UInt8(hex[idx..<next], radix: 16),
                  hex[idx..<next].allSatisfy({ $0.isNumber || ("a"..."f").contains($0) })
            else { return nil }
            out.append(byte)
            idx = next
        }
        return out
    }

    static func encodeSeedHex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
