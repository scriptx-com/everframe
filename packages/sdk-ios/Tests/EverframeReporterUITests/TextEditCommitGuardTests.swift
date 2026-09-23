// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Regression coverage for Task 8 review "Fix round 1", Finding 1: Undo /
// Redo / Clear / Trash used to mutate `annotations`/`history` WITHOUT first
// committing an in-flight inline text edit. Concretely: editing an existing
// committed `.text` shape, then tapping Undo before the edit committed
// (e.g. via Done or a new touch session), would swap the backing array out
// from under the still-live UITextView; the eventual `.patch(id)` commit
// would then find no matching id (or a stale one) and silently no-op,
// dropping the user's typed text.
//
// This drives the REAL production commit path — `FocusedAnnotationViewController
// .undoTapped()`/`.redoTapped()`, the exact `@objc` methods the Undo/Redo
// buttons invoke via target-action — rather than re-implementing the commit
// decision in the test. `undoTapped`/`redoTapped` stay Swift-`private` (the
// convention every other palette button follows); we reach them the same
// way UIKit itself does, via Objective-C selector dispatch. `textEditor` and
// `beginTextEditingExisting` are intentionally non-`private` (see their doc
// comments in FocusedAnnotationViewController.swift) so the test can stand
// up a real in-flight edit without a synthetic UITouch/gesture harness.
import Testing
import Foundation
#if canImport(UIKit) && !os(tvOS)
import UIKit
@testable import EverframeReporterUI

// .serialized: each test stands up its own real UIWindow and drives
// becomeFirstResponder()/resignFirstResponder() on a live UITextView — with
// Swift Testing's default parallel execution, two tests racing for
// first-responder/key-window status can cross-trigger each other's keyboard
// notifications. Force sequential execution so each test's window is fully
// torn down before the next begins.
@Suite(.serialized)
@MainActor
struct TextEditCommitGuardTests {

    /// 100×100 opaque source image — same recipe as BakeRendererTests'
    /// `makeWhiteImage()` — real (non-zero) size so `ImageTransform` and the
    /// text editor's frame math don't degenerate.
    private func makeSourceImage() -> UIImage {
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1.0
        format.opaque = true
        let r = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 100), format: format)
        return r.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        }
    }

    /// Stands up a real (windowed, laid-out) FocusedAnnotationViewController
    /// seeded with one committed `.text` shape, selected and already in an
    /// active re-edit session (mirrors the "second tap on an already-
    /// selected text shape" entry point `gestureEnded` uses).
    private func makeEditingVC(seedText: String) -> (vc: FocusedAnnotationViewController, window: UIWindow, shapeId: AnnotationId) {
        let seed = Annotation.text(x: 10, y: 10, text: seedText, color: 0xFFFF3B30, fontSize: 24)
        let vc = FocusedAnnotationViewController(sourceImage: makeSourceImage(), annotations: [seed])

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 568))
        window.rootViewController = vc
        window.makeKeyAndVisible()
        vc.loadViewIfNeeded()
        vc.view.layoutIfNeeded()

        vc.selectedId = seed.id
        vc.beginTextEditingExisting(seed.id)
        return (vc, window, seed.id)
    }

    @Test func undoCommitsInFlightEditBeforeUndoing() throws {
        let (vc, window, shapeId) = makeEditingVC(seedText: "original")
        _ = window // keep the window alive for the VC's lifetime

        // Simulate typing — mutates the SAME UITextView instance
        // `commitTextEditingIfAny()` will read from.
        #expect(vc.textEditor != nil)
        vc.textEditor?.text = "changed"

        // Invoke the real Undo button target-action. `undoTapped` is
        // `@objc private` (matching every other palette button in this
        // file) — `perform(_:)` dispatches through the Objective-C runtime
        // exactly like UIKit's target-action machinery does, so this
        // exercises the production code path, not a re-implementation.
        vc.perform(Selector(("undoTapped")))

        // Assertion 1: the pre-fix bug was that the live edit never reached
        // `annotations` at all before Undo swapped the array — "changed"
        // would never have existed anywhere, committed or not. Post-fix,
        // `commitTextEditingIfAny()` runs FIRST or `undoTapped`: it pushes
        // a snapshot of the PRE-edit state ("original") and patches
        // `annotations` to "changed"; `undoTapped` then pops that
        // just-pushed snapshot, so the visible state right after Undo is
        // "original" (the edit was committed, then undone — not silently
        // dropped).
        #expect(vc.annotations.first(where: { $0.id == shapeId })?.text == "original")

        // Assertion 2 (the stronger, deterministic proof the commit really
        // happened): Undo's own snapshot push means "changed" must be
        // sitting in `history.future`, recoverable via Redo. If the commit
        // had been skipped (the bug), there would be nothing for Redo to
        // recover — Undo would have popped further back into whatever
        // pre-existing history there was (none here), and Redo would be
        // unavailable or would restore the wrong state.
        #expect(vc.history.canRedo)
        vc.perform(Selector(("redoTapped")))
        #expect(vc.annotations.first(where: { $0.id == shapeId })?.text == "changed")
    }

    @Test func trashCommitsInFlightEditBeforeDeletingTheEditedShape() throws {
        let (vc, window, shapeId) = makeEditingVC(seedText: "original")
        _ = window

        vc.textEditor?.text = "changed"

        // Real Trash button target-action (`deleteSelectedTapped`).
        vc.perform(Selector(("deleteSelectedTapped")))

        // The shape is gone (Trash's own job)...
        #expect(vc.annotations.first(where: { $0.id == shapeId }) == nil)
        // ...but it must have been the COMMITTED ("changed") version that
        // got deleted, not silently discarded pre-commit — provable because
        // Undo (which now pops Trash's push) restores "changed", the edited
        // text, not "original".
        vc.perform(Selector(("undoTapped")))
        #expect(vc.annotations.first(where: { $0.id == shapeId })?.text == "changed")
    }
}
#endif
