// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure serializer tests — no UIKit gate needed since AnnotationWireFormat
// avoids UIKit (Foundation + CoreGraphics + TraceItXProtocol only).
//
// JSONAny (TraceItXProtocol/Generated.swift) decodes numbers by trying
// Bool, then Int64, then Double, then String — in that order — and
// Foundation's JSONDecoder happily decodes a whole-number JSON literal
// ("1") as Int64. So every whole-number coordinate we serialize (all the
// brief's test fixtures use whole numbers) round-trips as `Int64`, not
// `Double`, inside `JSONAny.value`. A literal `as? [Double]` / `as? Double`
// cast on those elements fails (Int64 and Double are distinct dynamic
// types — no cast-time widening). The helpers below unwrap either
// representation so the assertions stay semantically identical to "these
// are the numbers we expect" regardless of which numeric type JSONAny
// picked.
import Testing
import CoreGraphics
import Foundation
@testable import TraceItXReporterUI
import TraceItXProtocol

private func numberValue(_ any: Any?) -> Double? {
    if let d = any as? Double { return d }
    if let i = any as? Int64 { return Double(i) }
    if let i = any as? Int { return Double(i) }
    return nil
}

private func numberArray(_ any: Any?) -> [Double]? {
    guard let arr = any as? [Any] else { return nil }
    return arr.map { numberValue($0) ?? .nan }
}

struct AnnotationWireFormatTests {
    @Test func colorSerializesAsHex6() {
        let pen = Annotation.pen(points: [1, 2, 3, 4], color: 0xFFFF3B30, thickness: 4)
        let out = AnnotationWireFormat.serialize(annotations: [pen], partName: "screenshot")
        let dict = out.annotations[0].value as! [String: Any]
        #expect(dict["color"] as? String == "#FF3B30")
        #expect(dict["kind"] as? String == "pen")
        #expect(dict["partName"] as? String == "screenshot")
        #expect(numberArray(dict["points"]) == [1, 2, 3, 4])
    }

    @Test func blurMirrorsIntoRedactions() {
        let blur = Annotation.blur(x: 5, y: 6, width: 20, height: 10)
        let out = AnnotationWireFormat.serialize(annotations: [blur], partName: "annotated-screenshot-2")
        #expect(out.annotations.count == 1)
        #expect(out.redactions.count == 1)
        let r = out.redactions[0].value as! [String: Any]
        #expect(r["type"] as? String == "blur")
        #expect(r["partName"] as? String == "annotated-screenshot-2")
        #expect(numberValue(r["x"]) == 5 && numberValue(r["width"]) == 20)
    }

    @Test func arrowAndTextFieldShapes() {
        let arrow = Annotation.arrow(from: CGPoint(x: 1, y: 2), to: CGPoint(x: 3, y: 4), color: 0xFF000000, thickness: 2)
        let text = Annotation.text(x: 9, y: 9, text: "hi", color: 0xFFFFFFFF, fontSize: 24)
        let out = AnnotationWireFormat.serialize(annotations: [arrow, text], partName: "screenshot")
        let a = out.annotations[0].value as! [String: Any]
        #expect(numberArray(a["from"]) == [1, 2] && numberArray(a["to"]) == [3, 4])
        let t = out.annotations[1].value as! [String: Any]
        #expect(t["text"] as? String == "hi" && numberValue(t["fontSize"]) == 24)
    }

    @Test func blurAnnotationEntryOmitsColorAndThickness() {
        let blur = Annotation.blur(x: 1, y: 2, width: 3, height: 4)
        let out = AnnotationWireFormat.serialize(annotations: [blur], partName: "screenshot")
        let dict = out.annotations[0].value as! [String: Any]
        #expect(dict["color"] == nil)
        #expect(dict["thickness"] == nil)
    }

    @Test func nonBlurShapesDoNotMirrorIntoRedactions() {
        let rect = Annotation.rect(x: 0, y: 0, width: 10, height: 10, color: 0xFFFF3B30, thickness: 2)
        let out = AnnotationWireFormat.serialize(annotations: [rect], partName: "screenshot")
        #expect(out.annotations.count == 1)
        #expect(out.redactions.isEmpty)
    }
}
