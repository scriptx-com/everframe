// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// AnnotationWireFormat — serializes the pure `Annotation` model (this
// module) into the web-wire-compatible JSON shapes consumed by the ingest
// service (`payload.annotations[]` / `payload.redactions[]`). Mirrors web
// `ReporterDialog.tsx` (annotation → wire dict spread + `partName`).
//
// NO UIKit import — this file, like AnnotationModel.swift, must compile and
// run under plain `swift test` on macOS so the serializer is testable
// without a UIWindow.
//
// Module direction: `Annotation` lives here (upper module,
// TraceItXReporterUI); `ReporterSubmission` lives one module down
// (TraceItXKit) and cannot see `Annotation`. This serializer is therefore
// the ONLY place shape→wire-dict knowledge lives — `Inputs.Shot` on the
// lower-module side carries only the already-serialized `[JSONAny]`
// produced here.
//
// JSONAny (TraceItXProtocol/Generated.swift) has no public
// `init(_ value: Any)` — its only initializer is `init(from: Decoder)`, so
// the sole way to construct instances is a JSON round-trip: serialize a
// `[String: Any]` payload through `JSONSerialization`, then decode it back
// as `[JSONAny]`. This is the same approach `EnvelopeBuilder.toJSONAnyArray`
// uses for `payload.logs` / `payload.network`.
import Foundation
import CoreGraphics
import TraceItXProtocol

public enum AnnotationWireFormat {

    /// Serializes `annotations` (all belonging to ONE shot/screenshot part
    /// named `partName`) into the wire's `annotations[]` entries plus the
    /// `redactions[]` mirror for blur shapes.
    ///
    /// Field shapes per kind (web `ReporterDialog.tsx:267-279`):
    ///   pen/highlighter: `{id, kind, points, color, thickness, partName}`
    ///   rect/ellipse:    `{id, kind, x, y, width, height, color, thickness, partName}`
    ///   arrow:           `{id, kind, from: [x,y], to: [x,y], color, thickness, partName}`
    ///   text:            `{id, kind, x, y, text, color, fontSize, partName}`
    ///   blur:            `{id, kind, x, y, width, height, partName}` (no
    ///                     color/thickness — blur carries neither on the
    ///                     wire) — ALSO mirrored into `redactions[]` as
    ///                     `{x, y, width, height, type: "blur", partName}`.
    ///
    /// Colors serialize as `#RRGGBB` (alpha channel dropped — annotation
    /// colors are always opaque on the wire, matching web). `kind` is
    /// always lowercase (matches `AnnotationKind.rawValue`).
    public static func serialize(
        annotations: [Annotation],
        partName: String
    ) -> (annotations: [JSONAny], redactions: [JSONAny]) {
        var annotationDicts: [[String: Any]] = []
        var redactionDicts: [[String: Any]] = []

        for a in annotations {
            var dict: [String: Any] = [
                "id": a.id,
                "kind": a.kind.rawValue,
                "partName": partName,
            ]
            switch a.kind {
            case .pen, .highlighter:
                dict["points"] = a.points.map(Double.init)
                dict["color"] = hexColor(a.color)
                dict["thickness"] = Double(a.thickness)
            case .rect, .ellipse:
                dict["x"] = Double(a.x)
                dict["y"] = Double(a.y)
                dict["width"] = Double(a.width)
                dict["height"] = Double(a.height)
                dict["color"] = hexColor(a.color)
                dict["thickness"] = Double(a.thickness)
            case .arrow:
                dict["from"] = [Double(a.from.x), Double(a.from.y)]
                dict["to"] = [Double(a.to.x), Double(a.to.y)]
                dict["color"] = hexColor(a.color)
                dict["thickness"] = Double(a.thickness)
            case .text:
                dict["x"] = Double(a.x)
                dict["y"] = Double(a.y)
                dict["text"] = a.text
                dict["color"] = hexColor(a.color)
                dict["fontSize"] = Double(a.fontSize)
            case .blur:
                dict["x"] = Double(a.x)
                dict["y"] = Double(a.y)
                dict["width"] = Double(a.width)
                dict["height"] = Double(a.height)
            }
            annotationDicts.append(dict)

            if a.kind == .blur {
                redactionDicts.append([
                    "x": Double(a.x),
                    "y": Double(a.y),
                    "width": Double(a.width),
                    "height": Double(a.height),
                    "type": "blur",
                    "partName": partName,
                ])
            }
        }

        return (
            (try? toJSONAnyArray(annotationDicts)) ?? [],
            (try? toJSONAnyArray(redactionDicts)) ?? []
        )
    }

    /// `color & 0x00FFFFFF` drops the alpha byte (annotation colors are the
    /// palette's `0xFFrrggbb` literals — always fully opaque); `%06X`
    /// zero-pads so e.g. `0x0000FF` prints `#0000FF`, not `#FF`.
    private static func hexColor(_ color: UInt32) -> String {
        String(format: "#%06X", color & 0x00FFFFFF)
    }

    /// Encode a `[[String: Any]]` payload through JSON to obtain `[JSONAny]`
    /// — mirrors `EnvelopeBuilder.toJSONAnyArray` (private, lower module;
    /// duplicated here rather than shared because the two live in different
    /// modules with the lower one unable to see `Annotation`).
    private static func toJSONAnyArray(_ rows: [[String: Any]]) throws -> [JSONAny] {
        let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
        return try JSONDecoder().decode([JSONAny].self, from: data)
    }
}
