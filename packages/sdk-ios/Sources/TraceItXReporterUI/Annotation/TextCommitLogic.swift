// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 13.1 — Reporter Annotation Redesign · Plan 13.1-01 (Wave 1)
// Task 8 (native report-window parity): the text tool's commit decision —
// which of the four outcomes a Done/blur/next-touch commit produces — is
// pure value logic over (was there already a committed shape?, is the final
// text empty?). Extracted here (pattern from Tasks 6-7's SessionArbitration.swift
// and ShotListOps.swift reviews) so it compiles and is unit-testable under
// plain `swift test`, with no UIKit/UITextView dependency. The VC's
// `commitTextEditingIfAny()` only executes what this decides.
//
// The four outcomes (web QA locks — see AnnotateCanvas.tsx `commitTextEdit`):
//   new + non-empty      → append a new `.text` shape, select it, ONE push.
//   new + empty/whitespace → cancel silently — NO history entry (a never-
//                             committed placement is not an edit).
//   existing + non-empty  → patch the shape's text, ONE push.
//   existing + now-empty  → remove the shape, ONE push (one undo restores —
//                             web QA lock: clearing text deletes, it does not
//                             leave a zero-text shape behind).
import Foundation

/// What `commitTextEditingIfAny()` should do with the in-flight editor's
/// final value. `existingId == nil` means the session was placing a NEW
/// text (never yet in `annotations`); non-nil means it was re-editing an
/// already-committed `.text` shape.
public enum TextCommitAction: Equatable, Sendable {
    case appendNew
    case cancel
    case patch(AnnotationId)
    case delete(AnnotationId)
}

/// Pure commit-decision function. `trimmedText` need not be pre-trimmed by
/// the caller — whitespace-only (including all-newlines) text is treated as
/// empty regardless, matching web's `value.replace(/\s+$/, '')` + a
/// length-0 check (native trims BOTH ends since UITextView has no notion of
/// "trailing-only" trim being meaningfully different here).
public func textCommitAction(existingId: AnnotationId?, trimmedText: String) -> TextCommitAction {
    let isEmpty = trimmedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    if let id = existingId {
        return isEmpty ? .delete(id) : .patch(id)
    }
    return isEmpty ? .cancel : .appendNew
}
