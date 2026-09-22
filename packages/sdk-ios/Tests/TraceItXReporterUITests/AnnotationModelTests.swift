// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure-model tests — AnnotationModel has no UIKit dependency, so these run
// unconditionally under `swift test` on every platform slice.
import Testing
import CoreGraphics
@testable import TraceItXReporterUI

struct AnnotationModelTests {
    @Test func idsAreMonotonicAndUnique() {
        let a = newAnnotationId()
        let b = newAnnotationId()
        #expect(a != b)
    }

    @Test func constantsMatchWeb() {
        #expect(AnnotationConstants.penColors == [0xFFFF3B30, 0xFFFFCC00, 0xFF32ADE6, 0xFFFFFFFF, 0xFF000000])
        #expect(AnnotationConstants.penThicknesses == [2, 4, 8])
        #expect(AnnotationConstants.textFontSizes == [16, 24, 36])
        #expect(AnnotationConstants.highlighterOpacity == 0.45)
        #expect(AnnotationConstants.highlighterWidthMultiplier == 3)
        #expect(AnnotationConstants.historyCap == 50)
    }

    @Test func historyPushUndoRedo() {
        var h = EditorHistory()
        let s0: [Annotation] = []
        let s1 = [Annotation.pen(points: [0, 0, 10, 10], color: 0xFFFF3B30, thickness: 4)]
        h.push(snapshot: s0)                       // record state BEFORE the edit
        let undone = h.undo(current: s1)
        #expect(undone == s0)
        let redone = h.redo(current: s0)
        #expect(redone == s1)
    }

    @Test func historyPushClearsFuture() {
        var h = EditorHistory()
        let s0: [Annotation] = []
        let s1 = [Annotation.rect(x: 1, y: 1, width: 5, height: 5, color: 0xFF000000, thickness: 2)]
        h.push(snapshot: s0)
        _ = h.undo(current: s1)
        h.push(snapshot: s0)                       // new edit after undo
        #expect(h.redo(current: s0) == nil)        // redo invalidated
    }

    @Test func historyCapsAtFifty() {
        var h = EditorHistory()
        for i in 0..<60 {
            h.push(snapshot: [Annotation.text(x: CGFloat(i), y: 0, text: "\(i)", color: 0xFFFFFFFF, fontSize: 16)])
        }
        var undos = 0
        var current: [Annotation] = []
        while let prev = h.undo(current: current) { current = prev; undos += 1 }
        #expect(undos == 50)
    }

    @Test func undoOnEmptyHistoryReturnsNil() {
        var h = EditorHistory()
        #expect(h.undo(current: []) == nil)
        #expect(h.redo(current: []) == nil)
    }
}

struct AnnotationGeometryTests {
    @Test func normalizeFlipsNegativeBox() {
        let a = Annotation.rect(x: 10, y: 10, width: -6, height: -4, color: 0, thickness: 2)
        let b = normalizedBox(a)
        #expect(b == CGRect(x: 4, y: 6, width: 6, height: 4))
    }

    @Test func translateEveryKind() {
        let pen = Annotation.pen(points: [0, 0, 10, 10], color: 0, thickness: 2)
        #expect(translateAnnotation(pen, dx: 5, dy: 3).points == [5, 3, 15, 13])
        let arrow = Annotation.arrow(from: CGPoint(x: 1, y: 1), to: CGPoint(x: 9, y: 9), color: 0, thickness: 2)
        let movedArrow = translateAnnotation(arrow, dx: 1, dy: 2)
        #expect(movedArrow.from == CGPoint(x: 2, y: 3) && movedArrow.to == CGPoint(x: 10, y: 11))
        let box = Annotation.text(x: 5, y: 5, text: "t", color: 0, fontSize: 16)
        let movedBox = translateAnnotation(box, dx: -2, dy: 4)
        #expect(movedBox.x == 3 && movedBox.y == 9)
    }

    @Test func hitTestInteriorOfUnfilledRect() {
        // Web QA bug #1 — the CENTER of an outline-only rect must hit.
        let r = Annotation.rect(x: 10, y: 10, width: 100, height: 100, color: 0, thickness: 2)
        #expect(hitTest([r], at: CGPoint(x: 60, y: 60), tolerance: 8) == r.id)
        #expect(hitTest([r], at: CGPoint(x: 200, y: 200), tolerance: 8) == nil)
    }

    @Test func hitTestTopmostWins() {
        let bottom = Annotation.rect(x: 0, y: 0, width: 50, height: 50, color: 0, thickness: 2)
        let top = Annotation.ellipse(x: 20, y: 20, width: 50, height: 50, color: 0, thickness: 2)
        // Overlap region — later array entry (top) must win.
        #expect(hitTest([bottom, top], at: CGPoint(x: 30, y: 30), tolerance: 8) == top.id)
    }

    @Test func hitTestPenByDistanceToPolyline() {
        let pen = Annotation.pen(points: [0, 0, 100, 0], color: 0, thickness: 4)
        #expect(hitTest([pen], at: CGPoint(x: 50, y: 5), tolerance: 8) == pen.id)   // 5px off the line
        #expect(hitTest([pen], at: CGPoint(x: 50, y: 40), tolerance: 8) == nil)
    }

    @Test func handlesPerKind() {
        let rect = Annotation.rect(x: 0, y: 0, width: 10, height: 10, color: 0, thickness: 2)
        #expect(handles(for: rect).count == 4)
        let arrow = Annotation.arrow(from: .zero, to: CGPoint(x: 10, y: 0), color: 0, thickness: 2)
        let ah = handles(for: arrow)
        #expect(ah.map { $0.kind } == [HandleKind.arrowFrom, HandleKind.arrowTo])
        let pen = Annotation.pen(points: [0, 0, 1, 1], color: 0, thickness: 2)
        #expect(handles(for: pen).isEmpty)   // strokes are move-only
    }

    @Test func resizeClampsToMinBoxEdge() {
        let r = Annotation.rect(x: 0, y: 0, width: 20, height: 20, color: 0, thickness: 2)
        // Drag bottom-right past the top-left corner — box must not invert below 3px.
        let shrunk = applyResize(r, handle: .corner(.bottomRight), to: CGPoint(x: 1, y: 1))
        let b = normalizedBox(shrunk)
        #expect(b.width >= AnnotationConstants.minBoxEdge && b.height >= AnnotationConstants.minBoxEdge)
    }

    @Test func resizeTextScalesFontSizeWithFloor() {
        var t = Annotation.text(x: 0, y: 0, text: "hi", color: 0, fontSize: 24)
        t.width = 100; t.height = 30   // editor stamps measured bounds before handles show
        let bigger = applyResize(t, handle: .corner(.bottomRight), to: CGPoint(x: 200, y: 60))
        #expect(bigger.fontSize == 48)  // 2× width ratio
        let tiny = applyResize(t, handle: .corner(.bottomRight), to: CGPoint(x: 4, y: 2))
        #expect(tiny.fontSize == AnnotationConstants.minTextFontSize)
    }

    @Test func resizeArrowMovesEndpoint() {
        let a = Annotation.arrow(from: .zero, to: CGPoint(x: 10, y: 10), color: 0, thickness: 2)
        let r = applyResize(a, handle: .arrowTo, to: CGPoint(x: 50, y: 5))
        #expect(r.to == CGPoint(x: 50, y: 5) && r.from == .zero)
    }

    @Test func resizeTextKeepsAnchorPinned() {
        // .topLeft drag: bottom-right corner is the anchor and must not move.
        var t = Annotation.text(x: 0, y: 0, text: "hi", color: 0, fontSize: 24)
        t.width = 100; t.height = 30
        let resized = applyResize(t, handle: .corner(.topLeft), to: CGPoint(x: -50, y: -50))
        let b = normalizedBox(resized)
        #expect(b.maxX == 100 && b.maxY == 30)   // anchor pinned
        #expect(b.minX == -50 && b.minY == -50)  // dragged corner follows
    }

    @Test func commitThresholdRejectsDegenerateBoxes() {
        let sliver = Annotation.blur(x: 0, y: 0, width: 10, height: 1)
        #expect(meetsCommitThreshold(sliver) == false)   // would bake as ~nothing
        let ok = Annotation.blur(x: 0, y: 0, width: 5, height: 5)
        #expect(meetsCommitThreshold(ok) == true)
    }

    @Test func commitThresholdStrokesUseDragExtent() {
        let shortPen = Annotation.pen(points: [0, 0, 2, 2], color: 0, thickness: 2)
        #expect(meetsCommitThreshold(shortPen) == false)
        let axisArrow = Annotation.arrow(from: .zero, to: CGPoint(x: 6, y: 0), color: 0, thickness: 2)
        #expect(meetsCommitThreshold(axisArrow) == true)  // axis-aligned drags are fine for lines
    }
}

/// Task 6 review fix (round 1): the `.pending` touch-session arbitration
/// (Annotation/SessionArbitration.swift) extracted out of
/// FocusedAnnotationViewController, whose inline version had a bug that no
/// unit test could see (finding 1). These tests pin the arbitration table.
struct SessionArbitrationTests {
    // MARK: - resolveDrag

    @Test func handlePlusSelectionResolvesToResize() {
        #expect(resolveDrag(activeTool: .pointer, onHandle: .corner(.topLeft), onShape: nil, selectedId: "a1") == .resize(.corner(.topLeft)))
    }

    @Test func dragOnSelectedShapeResolvesToMove() {
        #expect(resolveDrag(activeTool: .pointer, onHandle: nil, onShape: "a1", selectedId: "a1") == .move("a1"))
    }

    @Test func pointerOnUnselectedShapeResolvesToMove() {
        #expect(resolveDrag(activeTool: .pointer, onHandle: nil, onShape: "a2", selectedId: "a1") == .move("a2"))
    }

    @Test func penElsewhereResolvesToDraw() {
        #expect(resolveDrag(activeTool: .pen, onHandle: nil, onShape: nil, selectedId: nil) == .draw)
    }

    @Test func pointerOverEmptyResolvesToIgnore() {
        #expect(resolveDrag(activeTool: .pointer, onHandle: nil, onShape: nil, selectedId: nil) == .ignore)
    }

    // MARK: - resolveTap

    @Test func tapShapeWithPenToolSelects() {
        #expect(resolveTap(activeTool: .pen, onShape: "a1") == .select("a1"))
    }

    @Test func tapEmptyWithPenToolDeselects() {
        #expect(resolveTap(activeTool: .pen, onShape: nil) == .deselect)
    }

    // MARK: - isDrawingTool

    @Test func drawingToolsClassifiedCorrectly() {
        for t: AnnotationTool in [.pen, .highlighter, .rect, .ellipse, .arrow, .redact] {
            #expect(isDrawingTool(t) == true)
        }
        for t: AnnotationTool in [.pointer, .text] {
            #expect(isDrawingTool(t) == false)
        }
    }
}

/// Task 7 review fix (round 1): the multi-shot strip's branching logic
/// (delete confirm, neighbor selection, add-tile cap) extracted out of ReporterViewController into pure
/// Annotation/ShotListOps.swift so it's unit-testable under plain swift test.
struct ShotListOpsTests {
    @Test func confirmOnlyWhenAnnotated() {
        #expect(ShotListOps.deleteNeedsConfirmation(annotationCount: 0) == false)
        #expect(ShotListOps.deleteNeedsConfirmation(annotationCount: 3) == true)
    }
    @Test func deleteSelectsNeighbor() {
        // 3 shots, delete middle (1) → active stays 1 (the old index now points at the next shot)
        #expect(ShotListOps.delete(at: 1, count: 3)
                == ShotListOps.DeleteOutcome(newActiveIndex: 1))
        // delete last (2) of 3 → active clamps to 1
        #expect(ShotListOps.delete(at: 2, count: 3).newActiveIndex == 1)
        // delete the only shot → empty list allowed
        #expect(ShotListOps.delete(at: 0, count: 1)
                == ShotListOps.DeleteOutcome(newActiveIndex: nil))
    }
    @Test func addTileHiddenAtCap() {
        #expect(ShotListOps.showsAddTile(count: 4) == true)
        #expect(ShotListOps.showsAddTile(count: 5) == false)
        #expect(ShotListOps.showsAddTile(count: 0) == true)
    }
}

/// Task 8: the text tool's commit-decision table — four outcomes over
/// (existing shape? × final text empty?) — extracted to Annotation/
/// TextCommitLogic.swift so the deterministic-commit contract (the whole
/// point of Task 8 — every path that can trigger a commit must agree on
/// what happens) is unit-tested without any UITextView/UIKit involved.
struct TextCommitLogicTests {
    @Test func newNonEmptyAppends() {
        #expect(textCommitAction(existingId: nil, trimmedText: "hello") == .appendNew)
    }
    @Test func newEmptyCancelsSilently() {
        #expect(textCommitAction(existingId: nil, trimmedText: "") == .cancel)
    }
    @Test func newWhitespaceOnlyIsEmpty() {
        #expect(textCommitAction(existingId: nil, trimmedText: "   \n  \t ") == .cancel)
    }
    @Test func existingNonEmptyPatches() {
        #expect(textCommitAction(existingId: "a1", trimmedText: "hello") == .patch("a1"))
    }
    @Test func existingEmptyDeletes() {
        #expect(textCommitAction(existingId: "a1", trimmedText: "") == .delete("a1"))
    }
    @Test func existingWhitespaceOnlyDeletes() {
        #expect(textCommitAction(existingId: "a1", trimmedText: "   \n\n  ") == .delete("a1"))
    }
}

/// Task 9: the area-capture crop math (selection rect, in host-window
/// points, → the pixel rect to crop out of ScreenshotCapture's bitmap) —
/// extracted to Annotation/AreaCropMath.swift so the downscale-factor
/// handling and edge-clamping are unit-tested without any UIWindow/UIImage
/// involved.
struct AreaCropMathTests {
    /// Tolerance for float-arithmetic comparisons below (multiplication by a
    /// ratio like 2.048 isn't bit-exact).
    private func approxEqual(_ a: CGRect, _ b: CGRect, tol: CGFloat = 0.01) -> Bool {
        abs(a.minX - b.minX) < tol && abs(a.minY - b.minY) < tol
            && abs(a.width - b.width) < tol && abs(a.height - b.height) < tol
    }

    @Test func identityNoDownscaleScale2() {
        // Captured image size == host bounds size ⇒ downscaleFactor == 1;
        // only the device screen scale (2×) applies.
        let rect = cropRectInPixels(
            selection: CGRect(x: 10, y: 10, width: 100, height: 100),
            hostBoundsSize: CGSize(width: 400, height: 800),
            capturedImageSize: CGSize(width: 400, height: 800),
            capturedImageScale: 2
        )
        #expect(approxEqual(rect, CGRect(x: 20, y: 20, width: 200, height: 200)))
    }

    @Test func downscaledCaseAppliesRatio() {
        // Captured image size != host bounds size ⇒ a non-1.0 downscaleFactor
        // (2048/1000 == 2.048) combines with the screen scale.
        let rect = cropRectInPixels(
            selection: CGRect(x: 100, y: 100, width: 200, height: 200),
            hostBoundsSize: CGSize(width: 1000, height: 2000),
            capturedImageSize: CGSize(width: 2048, height: 4096),
            capturedImageScale: 1
        )
        let expectedScale: CGFloat = 2048.0 / 1000.0
        #expect(approxEqual(rect, CGRect(
            x: 100 * expectedScale, y: 100 * expectedScale,
            width: 200 * expectedScale, height: 200 * expectedScale
        )))
    }

    @Test func clampsWhenSelectionOverhangsEdges() {
        // Image pixel bounds are 400×800 (scale 1, no downscale); a selection
        // that runs off the bottom-right must clip to the image edge.
        let rect = cropRectInPixels(
            selection: CGRect(x: 350, y: 750, width: 200, height: 200),
            hostBoundsSize: CGSize(width: 400, height: 800),
            capturedImageSize: CGSize(width: 400, height: 800),
            capturedImageScale: 1
        )
        #expect(approxEqual(rect, CGRect(x: 350, y: 750, width: 50, height: 50)))
    }

    @Test func emptyIntersectionReturnsZero() {
        let rect = cropRectInPixels(
            selection: CGRect(x: 1000, y: 1000, width: 50, height: 50),
            hostBoundsSize: CGSize(width: 400, height: 800),
            capturedImageSize: CGSize(width: 400, height: 800),
            capturedImageScale: 1
        )
        #expect(rect == .zero)
    }

    @Test func degenerateHostBoundsReturnsZero() {
        let rect = cropRectInPixels(
            selection: CGRect(x: 10, y: 10, width: 100, height: 100),
            hostBoundsSize: .zero,
            capturedImageSize: CGSize(width: 400, height: 800),
            capturedImageScale: 2
        )
        #expect(rect == .zero)
    }
}
