// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Rolling breadcrumb ring buffer (spec §3) — mirrors
// packages/sdk-core/src/breadcrumbs/buffer.ts semantics EXACTLY: same t/seq
// stamping, same cap/evict-oldest, same freeze/discardAndResume/takeFrozen/
// clear lifecycle. MASK-BEFORE-BYTES: message + every string inside `data`
// pass through RedactionEngine BEFORE entering the buffer — same doctrine as
// replay (REPLAY-04); no raw PII is ever buffered. The `data` recursion is
// depth-capped (MAX_DATA_DEPTH) and — the Plan-1 redaction-leak fix — a
// subtree AT OR BEYOND the cap is never passed through raw: it is replaced
// wholesale with the '[TRUNCATED:DEPTH]' sentinel, since any strings inside
// it would otherwise skip redaction entirely.
//
// Template: LogRingBuffer.swift (NSLock, cap, kill-gate — mirrored exactly,
// including the test-only `honorsKillGate`-bypassing init).
//
// Config gating (Task 1's wire, `BreadcrumbsConfigWire`) is layered ON TOP of
// the kill-gate and is evaluated LIVE at add-time via `applyConfig`: nil ⇒
// defaults (enabled, all 7 kinds, maxCount 100) — the state before the first
// `/api/config` fetch resolves; `enabled == false` clears the chain
// immediately (kill-switch parity) and gates every subsequent add; a kind
// absent from the config's `kinds` makes that kind's `add` a no-op.
import Foundation
import TraceItXProtocol

public final class BreadcrumbRingBuffer: @unchecked Sendable {
    public static let shared = BreadcrumbRingBuffer()

    /// Buffer capacity default (spec §3/§6 `maxCount` default) — mirrors
    /// sdk-core's exported `MAX_BREADCRUMBS`.
    public static let defaultMaxCount = 100
    /// Protocol Breadcrumb.message ceiling — enforced at add-time (mirrors
    /// buffer.ts MAX_MESSAGE_CHARS). UTF-16 code units, matching JS `.length`.
    private static let maxMessageChars = 2048
    /// Recursion cap for `data` redaction (mirrors buffer.ts MAX_DATA_DEPTH).
    private static let maxDataDepth = 4
    /// Sentinel replacing an object/array subtree at/beyond maxDataDepth —
    /// never passed through raw (mirrors buffer.ts DEPTH_TRUNCATION_SENTINEL).
    private static let depthTruncationSentinel = "[TRUNCATED:DEPTH]"
    private static let redactor = RedactionEngine()

    /// The full kind set — the applyConfig(nil) / boot-time default. A
    /// function (not a stored `static let`) sidesteps the Swift 6
    /// concurrency-safety warning on a static value of a non-Sendable
    /// generated enum (same fix BreadcrumbTrim.swift documents for its
    /// `structuralKinds` set); computed fresh on each call is cheap (7 cases).
    private static func allKinds() -> Set<BreadcrumbKind> {
        [.console, .custom, .error, .lifecycle, .navigation, .network, .tap]
    }

    /// See NetworkRingBuffer.honorsKillGate — same rationale: `add` consults
    /// TraceItX.shared.captureGate by default; the test-only init below
    /// bypasses it so buffer-level specs don't need a live start().
    internal let honorsKillGate: Bool

    /// Test-only seam — mirrors `NetworkRingBuffer.preLockHook` and
    /// `NetworkBodyRingBuffer.preLockHook` exactly: invoked, when set, at the
    /// point between the cheap pre-lock gate read in `add` and `lock.lock()`,
    /// so a test can hold a crumb in that window and drive `kill()` to
    /// completion from another thread. Always nil in production (zero
    /// overhead: one optional-closure check). See `KillSwitchTests` for the
    /// regression test that drives this hook.
    internal var preLockHook: (() -> Void)?

    private let lock = NSLock()
    private var entries: [Breadcrumb] = []
    private var frozen: [Breadcrumb]?
    private var seq: Int = 0
    private var _maxCount: Int

    // Config-gating state (Task 1's wire). Defaults match applyConfig(nil):
    // open + all kinds — the state before the first config fetch resolves.
    private var configEnabled: Bool = true
    private var configKinds: Set<BreadcrumbKind> = BreadcrumbRingBuffer.allKinds()

    public init(maxCount: Int = 100) {
        self._maxCount = maxCount
        self.honorsKillGate = true
    }

    /// Test-only init that bypasses the global kill-gate check (mirrors
    /// LogRingBuffer's `capacity:honorsKillGate:` seam).
    internal init(maxCount: Int, honorsKillGate: Bool) {
        self._maxCount = maxCount
        self.honorsKillGate = honorsKillGate
    }

    // MARK: - Public surface

    public var maxCount: Int {
        lock.lock(); defer { lock.unlock() }
        return _maxCount
    }

    public var size: Int {
        lock.lock(); defer { lock.unlock() }
        return entries.count
    }

    /// Re-cap the buffer. Shrinking evicts oldest immediately; growing takes
    /// effect on future adds. Non-positive values are ignored (config/host
    /// input — never let a bad value zeroize the chain).
    public func setMaxCount(_ n: Int) {
        lock.lock(); defer { lock.unlock() }
        setMaxCountLocked(n)
    }

    private func setMaxCountLocked(_ n: Int) {
        guard n >= 1 else { return }
        _maxCount = n
        if entries.count > _maxCount {
            entries.removeFirst(entries.count - _maxCount)
        }
    }

    /// Redacts `message` and every string inside `data` BEFORE storing;
    /// stamps `t` (wall-clock epoch ms) + a monotonic `seq`; caps `message`
    /// at 2048 UTF-16 units; evicts oldest past `maxCount`. No-ops when the
    /// kill gate is closed (honorsKillGate) or the live config has disabled
    /// this kind / breadcrumbs entirely.
    public func add(
        kind: BreadcrumbKind, message: String, level: Level? = nil, data: [String: JSONAny]? = nil
    ) {
        // Cheap pre-lock fast path only. A thread that reads the gate open
        // here can still be descheduled before `lock.lock()`, let `kill()`
        // run to completion elsewhere (which flips `captureGate` false and
        // THEN calls `clear()` — see `TraceItX.kill()`), and only then resume
        // and append into a buffer `clear()` just zeroized. The re-check
        // below, taken while HOLDING the lock, is the authoritative one —
        // same total order `NetworkRingBuffer` and `NetworkBodyRingBuffer`
        // rely on. The window is unusually wide here because redaction runs
        // between the two.
        if honorsKillGate, !TraceItX.shared.captureGate { return }
        preLockHook?()

        let capped = Self.capMessage(Self.redactor.redact(message))
        let redactedData = data.map { Self.redactDataForStorage($0) }

        lock.lock(); defer { lock.unlock() }
        if honorsKillGate, !TraceItX.shared.captureGate { return }
        guard configEnabled, configKinds.contains(kind) else { return }

        let crumb = Breadcrumb(
            data: redactedData,
            kind: kind,
            level: level,
            message: capped.message,
            seq: seq,
            t: Date().timeIntervalSince1970 * 1000,
            truncated: capped.truncated ? true : nil
        )
        seq += 1
        entries.append(crumb)
        if entries.count > _maxCount {
            entries.removeFirst(entries.count - _maxCount)
        }
    }

    /// Snapshot the chain at reporter-open. Idempotent — never a second
    /// snapshot while one is already held.
    public func freeze() {
        lock.lock(); defer { lock.unlock() }
        if frozen == nil { frozen = entries }
    }

    /// Drop the frozen snapshot (reporter cancelled). Live capture continues.
    public func discardAndResume() {
        lock.lock(); defer { lock.unlock() }
        frozen = nil
    }

    /// Return + clear the frozen snapshot, or nil if freeze() was never called.
    public func takeFrozen() -> [Breadcrumb]? {
        lock.lock(); defer { lock.unlock() }
        let out = frozen
        frozen = nil
        return out
    }

    /// Non-destructive copy of the LIVE chain for crash-time serialization
    /// (spec 2026-07-18). Independent of the freeze lifecycle.
    public func snapshot() -> [Breadcrumb] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }

    /// Zeroize everything (logout / identity change / kill switch).
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        entries.removeAll()
        frozen = nil
    }

    /// Live config gate (Task 1's wire), applied at the freshest point a
    /// `ReplayConfig` is read. `nil` ⇒ defaults (enabled, all 7 kinds,
    /// maxCount 100). `enabled == false` clears the chain immediately and
    /// gates every subsequent `add` until a future config re-enables it.
    public func applyConfig(_ cfg: BreadcrumbsConfigWire?) {
        lock.lock(); defer { lock.unlock() }
        guard let cfg = cfg else {
            configEnabled = true
            configKinds = Self.allKinds()
            setMaxCountLocked(Self.defaultMaxCount)
            return
        }
        configEnabled = cfg.enabled
        configKinds = Set(cfg.kinds.compactMap { BreadcrumbKind(rawValue: $0) })
        setMaxCountLocked(cfg.maxCount)
        if !configEnabled {
            entries.removeAll()
            frozen = nil
        }
    }

    public func isKindEnabled(_ kind: BreadcrumbKind) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return configEnabled && configKinds.contains(kind)
    }

    // MARK: - Redaction (mask-before-bytes) + depth-capped `data` recursion

    // SURROGATE EDGE (documented platform divergence — spec 2026-07-08
    // ruling): when this UTF-16 cut lands inside a surrogate pair, JS
    // .slice() and Kotlin substring keep the lone surrogate; Swift's
    // String(decoding:as:UTF16.self) substitutes U+FFFD (Swift String
    // cannot hold a lone surrogate). Accepted: each SDK trims only its own
    // crumbs, so the divergence cannot surface in a shipped report — it
    // exists only under a shared-oracle comparison. Pinned by the
    // characterization tests beside each mirror (see BreadcrumbTrim.swift).
    private static func capMessage(_ message: String) -> (message: String, truncated: Bool) {
        let units = Array(message.utf16)
        guard units.count > maxMessageChars else { return (message, false) }
        return (String(decoding: units.prefix(maxMessageChars), as: UTF16.self), true)
    }

    private static func redactDataForStorage(_ data: [String: JSONAny]) -> [String: JSONAny] {
        let unwrapped: [String: Any] = data.mapValues { $0.value }
        // The top-level dict is itself the depth-0 subject (mirrors buffer.ts
        // `redactData(input.data, redaction, 0)`) — it is never truncated at
        // depth 0 (0 < maxDataDepth), so the dict branch below always returns.
        guard let redacted = redactAny(unwrapped, depth: 0) as? [String: Any] else { return [:] }
        return mintJSONAny(redacted)
    }

    private static func redactAny(_ value: Any, depth: Int) -> Any {
        if let s = value as? String { return redactor.redact(s) }
        if let dict = value as? [String: Any] {
            if depth >= maxDataDepth { return depthTruncationSentinel }
            return dict.mapValues { redactAny($0, depth: depth + 1) }
        }
        if let arr = value as? [Any] {
            if depth >= maxDataDepth { return depthTruncationSentinel }
            return arr.map { redactAny($0, depth: depth + 1) }
        }
        // null / number / bool pass through verbatim (nothing to redact).
        return value
    }

    // MARK: - JSONAny minting
    //
    // JSONAny (Generated.swift) exposes no public initializer besides
    // `init(from decoder:)` (see BreadcrumbTrim.swift's identical note), so
    // the only way to mint one from a plain Swift value is a JSON round trip:
    // serialize, then decode back through JSONAny's own Decodable
    // conformance. JSONSerialization (not JSONEncoder) is used here because
    // the redacted tree is heterogeneous `Any` (String/Bool/Int64/Double/
    // JSONNull/[Any]/[String: Any]), not a single Encodable type. Fails soft
    // (never throws) — an unencodable/malformed graph yields [:] rather than
    // crashing the host.

    private static func mintJSONAny(_ dict: [String: Any]) -> [String: JSONAny] {
        let plain = dict.mapValues(plainJSONValue)
        guard JSONSerialization.isValidJSONObject(plain),
            let data = try? JSONSerialization.data(withJSONObject: plain)
        else { return [:] }
        return (try? JSONDecoder().decode([String: JSONAny].self, from: data)) ?? [:]
    }

    private static func plainJSONValue(_ value: Any) -> Any {
        if value is JSONNull { return NSNull() }
        if let arr = value as? [Any] { return arr.map(plainJSONValue) }
        if let dict = value as? [String: Any] { return dict.mapValues(plainJSONValue) }
        return value
    }

    /// `TraceItX.addBreadcrumb(data:)` coercion: host-supplied `[String: Any]`
    /// values are individually validated as JSON-encodable; anything that
    /// can't round-trip through JSON (Date, custom objects, closures, ...) is
    /// dropped entirely rather than crashing or throwing.
    static func coerceHostData(_ data: [String: Any]) -> [String: JSONAny] {
        var valid: [String: Any] = [:]
        for (key, value) in data where JSONSerialization.isValidJSONObject([value]) {
            valid[key] = value
        }
        return mintJSONAny(valid)
    }
}
