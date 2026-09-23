// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Importance-weighted breadcrumb trim (spec §4). Pure + platform-agnostic:
// mirrors packages/sdk-core/src/breadcrumbs/trim.ts EXACTLY — same constants,
// same eviction order, same cost model — locked by the shared parity fixture
// packages/protocol/__tests__/fixtures/breadcrumb-trim.v1.json.
//
// COST MODEL (deterministic + mirrorable; NOT kotlinx-serialization's
// Json.encodeToString, whose key ordering is platform-dependent): all
// lengths are UTF-16 code units. Kotlin's String is UTF-16-backed natively
// (String.length / String.substring already operate on UTF-16 code units,
// same as JS .length / .slice()), so — unlike the Swift mirror, which needs
// an explicit utf16 view — no special slicing technique is required here;
// plain String.substring is correct.
//   cost(crumb)   = entryOverhead + message.length + dataCost(data)
//   dataCost      : string → length · number|bool → 8 · null → 4
//                   array  → 2 + Σ(item + 2) · object → 2 + Σ(key.length + value + 2)
//                   absent data → 0
//
// INPUT INVARIANT (relied on for determinism): no two crumbs share the same
// (t, seq) pair. Kotlin's `sortedWith` IS stable, but — mirroring the Swift
// port for the same reason (and so this file stays a faithful twin of it) —
// identity for mustKeep/kept tracking is done by array INDEX into the sorted
// `entries` list, not by value equality: `Breadcrumb` is a `data class` with
// structural equals, and while the (t, seq) invariant already makes every
// entry structurally distinct in practice, index identity is the more
// robust and directly portable choice (matches trim.ts's reference-identity
// Set<Breadcrumb> without depending on that invariant for correctness of
// the identity tracking itself).
package dev.everframe.envelope

import dev.everframe.protocol.generated.Breadcrumb
import dev.everframe.protocol.generated.BreadcrumbKind
import dev.everframe.protocol.generated.Level
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

object BreadcrumbTrim {
    /** Total serialized-cost budget for the shipped chain (spec §4, default 16 KB). */
    const val byteBudget: Int = 16384
    /** Per-entry console message cap: first cap/2 + last cap/2 around a splice marker. */
    const val consoleEntryCap: Int = 1024
    /** Fixed per-entry cost covering the t/seq/kind/level envelope of a crumb. */
    const val entryOverhead: Int = 64
    /**
     * Hard entry ceiling for trimmed output: 128 (protocol payload.breadcrumbs
     * maxItems) minus 7 (worst case one trim marker per kind).
     */
    const val maxTrimmedEntries: Int = 121
    /** Error crumbs' data.stackDigest is capped to its first N newline-separated lines. */
    const val stackDigestMaxLines: Int = 10

    private val structuralKinds: Set<BreadcrumbKind> = setOf(
        BreadcrumbKind.Navigation,
        BreadcrumbKind.Tap,
        BreadcrumbKind.Lifecycle,
        BreadcrumbKind.Error,
        BreadcrumbKind.Custom,
    )

    /** Structural kinds are cheap and always-keep-first; console/network are trimmable. */
    fun isStructural(kind: BreadcrumbKind): Boolean = kind in structuralKinds

    /** A synthetic per-kind trim marker ("+N <kind> hidden")? Spec §1 discriminator. */
    fun isTrimMarker(crumb: Breadcrumb): Boolean {
        val prim = crumb.data?.get("droppedCount") as? JsonPrimitive ?: return false
        // A JSON boolean literal ("true"/"false") never parses as long/double,
        // so this already excludes booleans without a separate check — mirrors
        // JS's `typeof crumb.data?.['droppedCount'] === 'number'`.
        if (prim.isString) return false
        return prim.longOrNull != null || prim.doubleOrNull != null
    }

    /**
     * Head+tail middle-splice: over-cap messages keep the first and last cap/2
     * UTF-16 units around a `…[+N chars]…` marker (spec §4.2).
     *
     * SURROGATE EDGE (documented platform divergence — spec 2026-07-08 ruling):
     * when the UTF-16 cut lands inside a surrogate pair, JS .slice() and Kotlin
     * substring keep the lone surrogate; Swift's String(decoding:as:UTF16.self)
     * substitutes U+FFFD (Swift String cannot hold a lone surrogate). Accepted:
     * each SDK trims only its own crumbs, so the divergence cannot surface in a
     * shipped report — it exists only under a shared-oracle comparison. Pinned
     * by the characterization tests beside each mirror.
     */
    fun truncateMiddle(message: String, cap: Int): TruncateResult {
        if (message.length <= cap) return TruncateResult(message, false)
        val half = cap / 2
        val dropped = message.length - half * 2
        val head = message.substring(0, half)
        val tail = message.substring(message.length - half)
        return TruncateResult("$head…[+$dropped chars]…$tail", true)
    }

    data class TruncateResult(val message: String, val truncated: Boolean)

    /** Deterministic cross-platform cost of one crumb (see COST MODEL above). */
    fun crumbCost(crumb: Breadcrumb): Int =
        entryOverhead + crumb.message.length + dataCost(crumb.data)

    private fun dataCost(data: JsonObject?): Int {
        if (data == null) return 0
        var sum = 2
        for ((k, v) in data) sum += k.length + valueCost(v) + 2
        return sum
    }

    private fun valueCost(value: JsonElement): Int = when (value) {
        is JsonArray -> {
            var sum = 2
            for (item in value) sum += valueCost(item) + 2
            sum
        }
        is JsonObject -> {
            var sum = 2
            for ((k, v) in value) sum += k.length + valueCost(v) + 2
            sum
        }
        is JsonPrimitive -> {
            if (value is JsonNull) 4
            else if (value.isString) value.content.length
            else 8 // number or boolean
        }
    }

    /**
     * Importance-weighted trim (spec §4):
     *   1. per-entry truncation (console middle-splice; error stackDigest line cap),
     *   2. must-keep = the newest entry of every kind present,
     *   3. while over budget evict the oldest BULKY (console/network) crumb,
     *      then — only when no bulky remain — the oldest structural,
     *   4. after byte eviction, if more than maxTrimmedEntries entries remain,
     *      keep evicting in the SAME order (oldest bulky first, then oldest
     *      structural, skipping must-keep) until maxTrimmedEntries remain,
     *   5. one count marker per kind that lost entries, stamped with the newest
     *      dropped entry's (t, seq) so it sorts just before the kept window.
     * Markers are bounded (≤ one per kind) and excluded from the budget.
     */
    fun trim(
        crumbs: List<Breadcrumb>,
        byteBudget: Int = this.byteBudget,
        consoleEntryCap: Int = this.consoleEntryCap,
    ): List<Breadcrumb> {
        if (crumbs.isEmpty()) return emptyList()

        // 1. Per-entry truncation, then defensive (t, seq) sort for determinism.
        val entries: List<Breadcrumb> = crumbs
            .map { truncate(it, consoleEntryCap) }
            .sortedWith(compareBy({ it.t }, { it.seq }))

        // 2. Must-keep: the newest entry of every kind present — a kind that
        //    fired is never silently absent from the shipped chain.
        val mustKeepIndices = HashSet<Int>()
        val seenKinds = HashSet<BreadcrumbKind>()
        for (i in entries.indices.reversed()) {
            if (seenKinds.add(entries[i].kind)) {
                mustKeepIndices.add(i)
            }
        }

        // 3. Evict until under budget: oldest bulky first, structural last resort.
        //    `entries` is oldest→newest, so each filter pass is already in
        //    eviction order.
        val keptIndices = entries.indices.toHashSet()
        var total = entries.sumOf { crumbCost(it) }
        val evictionOrder: List<Int> =
            entries.indices.filter { !isStructural(entries[it].kind) } +
                entries.indices.filter { isStructural(entries[it].kind) }

        for (victim in evictionOrder) {
            if (total <= byteBudget) break
            if (victim in mustKeepIndices) continue
            keptIndices.remove(victim)
            total -= crumbCost(entries[victim])
        }

        // 3b. Count enforcement: the protocol caps payload.breadcrumbs at 128, so
        //     trimmed entries must never exceed maxTrimmedEntries (= 128 − 7
        //     worst-case markers). Walk the SAME eviction order; must-keep is at
        //     most 7 entries (one per kind), so the target is always reachable.
        for (victim in evictionOrder) {
            if (keptIndices.size <= maxTrimmedEntries) break
            if (victim in mustKeepIndices) continue
            keptIndices.remove(victim)
        }

        // 4. One count marker per kind that lost entries.
        val droppedByKind = LinkedHashMap<BreadcrumbKind, MutableList<Int>>()
        for (i in entries.indices) {
            if (i in keptIndices) continue
            droppedByKind.getOrPut(entries[i].kind) { mutableListOf() }.add(i)
        }
        val markers: List<Breadcrumb> = droppedByKind.map { (kind, droppedIndices) ->
            val newestDropped = entries[droppedIndices.last()]
            Breadcrumb(
                data = JsonObject(mapOf("droppedCount" to JsonPrimitive(droppedIndices.size))),
                kind = kind,
                level = Level.Info,
                message = "+${droppedIndices.size} ${kind.value} hidden",
                seq = newestDropped.seq,
                t = newestDropped.t,
                truncated = null,
            )
        }

        val kept: List<Breadcrumb> = entries.indices.filter { it in keptIndices }.map { entries[it] }
        return (kept + markers).sortedWith(compareBy({ it.t }, { it.seq }))
    }

    // --- Step 1: per-entry truncation ---

    private fun truncate(c: Breadcrumb, consoleCap: Int): Breadcrumb {
        if (c.kind == BreadcrumbKind.Console) {
            val r = truncateMiddle(c.message, consoleCap)
            if (!r.truncated) return c
            return c.copy(message = r.message, truncated = true)
        }
        if (c.kind == BreadcrumbKind.Error) {
            val stackDigestPrim = c.data?.get("stackDigest") as? JsonPrimitive
            val stackDigest = if (stackDigestPrim != null && stackDigestPrim.isString) stackDigestPrim.content else null
            if (stackDigest != null) {
                val lines = stackDigest.split("\n")
                if (lines.size > stackDigestMaxLines) {
                    val newStack = lines.take(stackDigestMaxLines).joinToString("\n")
                    val newData = JsonObject(
                        c.data!!.toMutableMap().apply { put("stackDigest", JsonPrimitive(newStack)) }
                    )
                    return c.copy(data = newData, truncated = true)
                }
            }
        }
        return c
    }
}
