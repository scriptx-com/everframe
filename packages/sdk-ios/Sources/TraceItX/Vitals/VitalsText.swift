// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Codex round-1, #11 — the wire's string limits are counted in UTF-16 code
// units, because that is what JavaScript's `String.length` (and therefore
// zod's `.max()` in packages/protocol/src/vitals.ts) counts. Swift's
// `String.prefix(n)` counts GRAPHEME CLUSTERS, so a 33-emoji custom name
// passed a 64-grapheme cut unchanged and arrived at ingest with a JS length of
// 66. Ingest then rejected the WHOLE chunk — every unrelated sample in it —
// and the same entry could contaminate an enriched report. Combining sequences
// widen the gap further.
import Foundation

enum VitalsText {
    /// Cut `s` to at most `budget` UTF-16 code units.
    ///
    /// Whole graphemes only: a surrogate pair is never split (which would make the string
    /// unrepresentable), and neither is a base character from its combining marks. A single
    /// grapheme that does not fit at all yields "" — the callers' own "unnamed"/omitted
    /// fallbacks handle that, and shipping half a code point never would.
    static func cut(_ s: String, toUTF16 budget: Int) -> String {
        guard budget > 0 else { return "" }
        guard s.utf16.count > budget else { return s }
        var out = ""
        var used = 0
        for ch in s {
            let n = ch.utf16.count
            if used + n > budget { break }
            out.append(ch)
            used += n
        }
        return out
    }
}
