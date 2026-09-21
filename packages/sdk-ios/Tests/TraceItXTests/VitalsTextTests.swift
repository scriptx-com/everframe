// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Codex round-4, M8. `VitalsText.cut` was the one file under
// `Sources/TraceItX/Vitals` with no suite of its own — reached only through the
// controller's and the registry's, which assert on the FIELDS it produces and
// never on the boundary it exists to hold. Round-1 #11's whole point is that
// the budget is counted in UTF-16 code units (JavaScript's `String.length`,
// which is what zod's `.max()` in `packages/protocol/src/vitals.ts` counts),
// while Swift's own `prefix(_:)` counts grapheme clusters: a 33-emoji name
// passed a 64-grapheme cut unchanged and arrived at ingest with a JS length of
// 66, and ingest rejected the whole chunk.
import XCTest
@testable import TraceItXKit

final class VitalsTextTests: XCTestCase {
    private func jsLength(_ s: String) -> Int { s.utf16.count }

    func testAStringInsideTheBudgetIsReturnedUntouched() {
        XCTAssertEqual(VitalsText.cut("ad_break", toUTF16: 64), "ad_break")
        XCTAssertEqual(VitalsText.cut("", toUTF16: 64), "")
        // Exactly on the budget is inside it.
        XCTAssertEqual(VitalsText.cut("abcd", toUTF16: 4), "abcd")
    }
    func testTheBudgetIsCountedInUTF16UnitsNotGraphemes() {
        // The failure round-1 #11 names: 33 emoji are 33 graphemes and 66 UTF-16 units.
        let name = String(repeating: "😀", count: 33)
        XCTAssertEqual(name.count, 33)
        XCTAssertEqual(jsLength(name), 66)
        let cut = VitalsText.cut(name, toUTF16: 64)
        XCTAssertLessThanOrEqual(jsLength(cut), 64, "a JS length over the cap makes ingest reject the whole chunk")
        XCTAssertEqual(cut, String(repeating: "😀", count: 32))
    }
    func testASurrogatePairIsNeverSplit() {
        // An odd budget cannot take half of a two-unit grapheme.
        let cut = VitalsText.cut(String(repeating: "😀", count: 4), toUTF16: 5)
        XCTAssertEqual(cut, String(repeating: "😀", count: 2))
        XCTAssertEqual(jsLength(cut), 4)
    }
    func testACombiningSequenceIsNeverSplitFromItsBase() {
        // "é" as e + U+0301: one grapheme, two UTF-16 units. A budget of 1 must drop it whole
        // rather than ship a bare combining mark (or a bare base).
        let s = "e\u{0301}x"
        XCTAssertEqual(s.count, 2); XCTAssertEqual(jsLength(s), 3)
        XCTAssertEqual(VitalsText.cut(s, toUTF16: 1), "")
        XCTAssertEqual(VitalsText.cut(s, toUTF16: 2), "e\u{0301}")
    }
    func testAGraphemeThatCannotFitAtAllYieldsEmptyRatherThanHalfACodePoint() {
        XCTAssertEqual(VitalsText.cut("😀abc", toUTF16: 1), "")
        XCTAssertEqual(VitalsText.cut("abc", toUTF16: 0), "")
        XCTAssertEqual(VitalsText.cut("abc", toUTF16: -1), "")
    }
    /// The budget is a byte-free measure on purpose: a name well inside it can still be several
    /// times its length in UTF-8, and that is the transport's problem, not this function's.
    func testTheCutIsNotAByteCut() {
        let s = String(repeating: "日", count: 10)     // 10 UTF-16 units, 30 UTF-8 bytes
        XCTAssertEqual(VitalsText.cut(s, toUTF16: 10), s)
        XCTAssertEqual(VitalsText.cut(s, toUTF16: 3), "日日日")
    }
}
