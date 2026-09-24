// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Rolling breadcrumb ring buffer (spec §3) — mirrors
// packages/sdk-core/src/breadcrumbs/buffer.ts semantics EXACTLY (also ported
// to packages/sdk-ios/Sources/Everframe/Capture/BreadcrumbRingBuffer.swift):
// same t/seq stamping, same cap/evict-oldest, same freeze/discardAndResume/
// takeFrozen/clear lifecycle. MASK-BEFORE-BYTES: message + every string
// inside `data` pass through RedactionEngine BEFORE entering the buffer —
// same doctrine as replay (REPLAY-04); no raw PII is ever buffered. The
// `data` recursion is depth-capped (MAX_DATA_DEPTH) and — the Plan-1
// redaction-leak fix — a subtree AT OR BEYOND the cap is never passed
// through raw: it is replaced wholesale with the "[TRUNCATED:DEPTH]"
// sentinel, since any strings inside it would otherwise skip redaction
// entirely.
//
// Template: LogRingBuffer.kt (ReentrantLock + ArrayDeque, process-wide
// shared instance). Kill-gate wiring mirrors the iOS twin's honorsKillGate
// seam — Android's LogRingBuffer/NetworkRingBuffer rely on callers to check
// the gate, but breadcrumbs put the check inside `add` itself to match iOS
// Task 5 and to gate Task-11's dual-writes uniformly.
//
// Config gating (Task 1's wire, `BreadcrumbsConfigWire`) is layered ON TOP of
// the kill-gate and is evaluated LIVE at add-time via `applyConfig`: null ⇒
// defaults (enabled, all 7 kinds, maxCount 100) — the state before the first
// `/api/config` fetch resolves; `enabled == false` clears the chain
// immediately (kill-switch parity) and gates every subsequent add; a kind
// absent from the config's `kinds` makes that kind's `add` a no-op.
package dev.everframe.capture

import androidx.annotation.VisibleForTesting
import dev.everframe.Everframe
import dev.everframe.config.BreadcrumbsConfigWire
import dev.everframe.envelope.RedactionEngine
import dev.everframe.protocol.generated.Breadcrumb
import dev.everframe.protocol.generated.BreadcrumbKind
import dev.everframe.protocol.generated.Level
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class BreadcrumbRingBuffer internal constructor(
    maxCount: Int,
    internal val honorsKillGate: Boolean,
) {
    /** Public production constructor — always honors the kill gate. */
    constructor(maxCount: Int = defaultMaxCount) : this(maxCount, true)

    companion object {
        /** Buffer capacity default (spec §3/§6 `maxCount` default) — mirrors sdk-core's MAX_BREADCRUMBS. */
        const val defaultMaxCount: Int = 100

        /** Protocol Breadcrumb.message ceiling — enforced at add-time. Kotlin's String is
         *  UTF-16-native (length/substring already operate on code units, same as JS .length/.slice()). */
        private const val maxMessageChars: Int = 2048

        /** Recursion cap for `data` redaction (mirrors buffer.ts MAX_DATA_DEPTH). */
        private const val maxDataDepth: Int = 4

        /** Sentinel replacing an object/array subtree at/beyond maxDataDepth — never passed through raw. */
        private const val depthTruncationSentinel: String = "[TRUNCATED:DEPTH]"

        /**
         * Recursion cap for `coerceValue`'s Map/List traversal — a pure crash guard
         * against pathological or accidentally-cyclic host-supplied `data`, NOT the
         * redaction authority on stored shape. Deliberately GENEROUS (far above
         * [maxDataDepth]'s 4): the redaction stage below already replaces any
         * subtree at/beyond depth 4 with [depthTruncationSentinel], so for every
         * realistic input the coerced structure reaches redaction fully intact and
         * redaction's depth-4 sentinel governs the output exactly as before. This
         * ceiling only ever fires on pathological depth or cycles, where it drops
         * the offending value (consistent with the existing non-coercible → drop
         * semantics) instead of overflowing the stack.
         */
        private const val maxCoerceDepth: Int = 64

        /** The full kind set — the applyConfig(null) / boot-time default. */
        private val allKinds: Set<BreadcrumbKind> = setOf(
            BreadcrumbKind.Console,
            BreadcrumbKind.Custom,
            BreadcrumbKind.Error,
            BreadcrumbKind.Lifecycle,
            BreadcrumbKind.Navigation,
            BreadcrumbKind.Network,
            BreadcrumbKind.Tap,
        )

        private data class CappedMessage(val message: String, val truncated: Boolean)

        // SURROGATE EDGE (documented platform divergence — spec 2026-07-08
        // ruling): when this UTF-16 cut lands inside a surrogate pair, JS
        // .slice() and Kotlin substring keep the lone surrogate; Swift's
        // String(decoding:as:UTF16.self) substitutes U+FFFD (Swift String
        // cannot hold a lone surrogate). Accepted: each SDK trims only its own
        // crumbs, so the divergence cannot surface in a shipped report — it
        // exists only under a shared-oracle comparison. Pinned by the
        // characterization tests beside each mirror (see BreadcrumbTrim.kt).
        private fun capMessage(message: String): CappedMessage =
            if (message.length > maxMessageChars) {
                CappedMessage(message.substring(0, maxMessageChars), truncated = true)
            } else {
                CappedMessage(message, truncated = false)
            }

        /** Depth-capped redaction of a `data` tree (see file header for the depth-cap invariant). */
        private fun redactElement(value: JsonElement, depth: Int): JsonElement = when (value) {
            is JsonObject ->
                if (depth >= maxDataDepth) {
                    JsonPrimitive(depthTruncationSentinel)
                } else {
                    JsonObject(value.mapValues { (_, v) -> redactElement(v, depth + 1) })
                }
            is JsonArray ->
                if (depth >= maxDataDepth) {
                    JsonPrimitive(depthTruncationSentinel)
                } else {
                    JsonArray(value.map { redactElement(it, depth + 1) })
                }
            is JsonPrimitive ->
                if (value.isString) JsonPrimitive(RedactionEngine.redact(value.content)) else value
        }

        /**
         * Redacts a top-level `data` object. The top-level object is itself the
         * depth-0 subject (mirrors buffer.ts `redactData(input.data, redaction, 0)`)
         * — it is never truncated at depth 0 (0 < maxDataDepth), so the object
         * branch above always returns a JsonObject here.
         */
        private fun redactDataForStorage(data: JsonObject): JsonObject =
            redactElement(data, 0) as? JsonObject ?: JsonObject(emptyMap())

        /**
         * `Everframe.addBreadcrumb(data:)` coercion: host-supplied `Map<String, Any?>`
         * values are individually validated as JSON-encodable; anything that can't
         * round-trip (custom objects, functions, ...) drops the WHOLE top-level
         * entry rather than crashing or throwing (fail-soft, mirrors iOS's
         * `coerceHostData` which uses `JSONSerialization.isValidJSONObject`).
         */
        fun coerceHostData(data: Map<String, Any?>): JsonObject {
            val result = LinkedHashMap<String, JsonElement>()
            for ((key, value) in data) {
                val coerced = coerceValue(value, depth = 0) ?: continue
                result[key] = coerced
            }
            return JsonObject(result)
        }

        /**
         * `depth` counts Map/List recursion only (mirrors [redactElement]'s depth
         * accounting); see [maxCoerceDepth] for why the ceiling is 64, not 4. A
         * value at/beyond the ceiling is coerced to null, i.e. dropped — the same
         * fate as any other non-coercible value.
         */
        private fun coerceValue(value: Any?, depth: Int): JsonElement? = when (value) {
            null -> JsonNull
            is String -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            is Int -> JsonPrimitive(value)
            is Long -> JsonPrimitive(value)
            is Float -> JsonPrimitive(value.toDouble())
            is Double -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value.toDouble())
            is Map<*, *> -> {
                if (depth >= maxCoerceDepth) {
                    null
                } else {
                    val nested = LinkedHashMap<String, JsonElement>()
                    var ok = true
                    for ((k, v) in value) {
                        val key = k as? String
                        val coercedV = if (key != null) coerceValue(v, depth + 1) else null
                        if (key == null || coercedV == null) {
                            ok = false
                            break
                        }
                        nested[key] = coercedV
                    }
                    if (ok) JsonObject(nested) else null
                }
            }
            is List<*> -> {
                if (depth >= maxCoerceDepth) {
                    null
                } else {
                    val items = ArrayList<JsonElement>()
                    var ok = true
                    for (item in value) {
                        val coercedItem = coerceValue(item, depth + 1)
                        if (coercedItem == null) {
                            ok = false
                            break
                        }
                        items.add(coercedItem)
                    }
                    if (ok) JsonArray(items) else null
                }
            }
            else -> null
        }
    }

    private val lock = ReentrantLock()
    private val entries = ArrayDeque<Breadcrumb>()
    private var frozen: List<Breadcrumb>? = null
    private var seq: Long = 0
    private var _maxCount: Int = maxCount

    // Config-gating state (Task 1's wire). Defaults match applyConfig(null):
    // open + all kinds — the state before the first config fetch resolves.
    private var configEnabled: Boolean = true
    private var configKinds: Set<BreadcrumbKind> = allKinds

    val maxCount: Int get() = lock.withLock { _maxCount }

    val size: Int get() = lock.withLock { entries.size }

    /**
     * Re-cap the buffer. Shrinking evicts oldest immediately; growing takes
     * effect on future adds. Non-positive values are ignored (config/host
     * input — never let a bad value zeroize the chain).
     */
    fun setMaxCount(n: Int) = lock.withLock { setMaxCountLocked(n) }

    private fun setMaxCountLocked(n: Int) {
        if (n < 1) return
        _maxCount = n
        while (entries.size > _maxCount) entries.removeFirst()
    }

    /**
     * Redacts `message` and every string inside `data` BEFORE storing; stamps
     * `t` (wall-clock epoch ms) + a monotonic `seq`; caps `message` at 2048
     * UTF-16 units; evicts oldest past `maxCount`. No-ops when the kill gate
     * is closed (honorsKillGate) or the live config has disabled this kind /
     * breadcrumbs entirely.
     */
    private var evidenceGeneration = 0L
    internal fun generation(): Long = lock.withLock { evidenceGeneration }
    internal fun rotate(owner: Long) = lock.withLock { evidenceGeneration = owner; clear() }
    internal fun addOwned(kind: BreadcrumbKind, message: String, level: Level?, owner: Long, data: JsonObject? = null) =
        add(kind, message, level, data, owner)

    fun add(kind: BreadcrumbKind, message: String, level: Level? = null, data: JsonObject? = null) =
        add(kind, message, level, data, null)

    private fun add(kind: BreadcrumbKind, message: String, level: Level?, data: JsonObject?, owner: Long?) {
        if (honorsKillGate && !Everframe.captureGate) return
        if (!isKindEnabled(kind)) return

        val capped = capMessage(RedactionEngine.redact(message))
        val redactedData = data?.let { redactDataForStorage(it) }

        lock.withLock {
            if (owner != null && owner != evidenceGeneration) return@withLock
            if (!configEnabled || kind !in configKinds) return@withLock

            val crumb = Breadcrumb(
                data = redactedData,
                kind = kind,
                level = level,
                message = capped.message,
                seq = seq,
                t = System.currentTimeMillis().toDouble(),
                truncated = if (capped.truncated) true else null,
            )
            seq += 1
            entries.addLast(crumb)
            if (entries.size > _maxCount) entries.removeFirst()
        }
    }

    /** Owner-bound immutable selection; source epoch is checked inside the ring lock. */
    fun snapshotForReport(): List<Breadcrumb> = lock.withLock { entries.toList() }
    internal fun snapshotForReport(guard: () -> Boolean): List<Breadcrumb>? = lock.withLock {
        if (guard()) entries.toList() else null
    }

    /** Snapshot the chain at reporter-open. Idempotent — never a second snapshot while one is already held. */
    fun freeze() = lock.withLock {
        if (frozen == null) frozen = entries.toList()
    }

    /** Drop the frozen snapshot (reporter cancelled). Live capture continues. */
    fun discardAndResume() = lock.withLock { frozen = null }

    /** Return + clear the frozen snapshot, or null if freeze() was never called. */
    fun takeFrozen(): List<Breadcrumb>? = lock.withLock {
        val out = frozen
        frozen = null
        out
    }

    /** Zeroize everything (logout / identity change / kill switch). */
    fun clear() = lock.withLock {
        entries.clear()
        frozen = null
    }

    /**
     * Live config gate (Task 1's wire), applied at the freshest point a
     * `ReplayConfig` is read. `null` ⇒ defaults (enabled, all 7 kinds,
     * maxCount 100). `enabled == false` clears the chain immediately and
     * gates every subsequent `add` until a future config re-enables it.
     */
    fun applyConfig(cfg: BreadcrumbsConfigWire?, guard: (() -> Boolean)? = null) = lock.withLock {
        if (guard?.invoke() == false) return@withLock
        if (cfg == null) {
            configEnabled = true
            configKinds = allKinds
            setMaxCountLocked(defaultMaxCount)
            return@withLock
        }
        configEnabled = cfg.enabled
        configKinds = cfg.kinds.mapNotNull { v -> BreadcrumbKind.entries.firstOrNull { it.value == v } }.toSet()
        setMaxCountLocked(cfg.maxCount)
        if (!configEnabled) {
            entries.clear()
            frozen = null
        }
    }

    fun isKindEnabled(kind: BreadcrumbKind): Boolean = lock.withLock { configEnabled && kind in configKinds }

    /**
     * Crash-time snapshot (spec 2026-07-18): non-destructive copy of the LIVE
     * chain. Uses tryLock with a bounded timeout — during uncaught-exception
     * unwind we must never deadlock behind another thread holding the lock;
     * losing the trail (empty list) is the acceptable degraded mode, on
     * timeout AND on interrupt (the timed tryLock overload throws
     * InterruptedException; we swallow it, restore the interrupt flag, and
     * degrade — nothing may ever propagate out of the crash path).
     */
    fun snapshotForCrash(timeoutMs: Long = 200): List<Breadcrumb> {
        val acquired = try {
            lock.tryLock(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return emptyList()
        }
        if (!acquired) return emptyList()
        try {
            return entries.toList()
        } finally {
            lock.unlock()
        }
    }

    /** Test-only: run [block] while holding the ring lock. */
    @VisibleForTesting
    internal fun __holdLockForTesting(block: () -> Unit) {
        lock.lock()
        try { block() } finally { lock.unlock() }
    }

    /**
     * Test-only (round-5 review Finding F24): true once at least one other
     * thread is blocked waiting to acquire [lock] — lets a test poll for
     * "a concurrent `applyConfig`/`add` call is genuinely blocked on this
     * buffer's lock" deterministically, instead of a fixed sleep, when
     * combined with [__holdLockForTesting] held from another thread.
     */
    @VisibleForTesting
    internal fun __hasQueuedThreadsForTesting(): Boolean = lock.hasQueuedThreads()
}

/**
 * Process-wide breadcrumb ring buffer. Capacity 100 by default (spec §3/§6) —
 * matches iOS `BreadcrumbRingBuffer.shared` + web. `applyConfig` is called
 * from `ReplaySession.enableIfConfigured()` on every fresh `/api/config` read
 * (independent of replay ON/OFF).
 */
val sharedBreadcrumbBuffer = BreadcrumbRingBuffer()
