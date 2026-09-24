// TextCommitLogic.kt
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Android Task 6 (native report-window parity) — the text tool's commit
// decision (which of the four outcomes a Done/blur/next-touch commit
// produces) is pure value logic over (was there already a committed shape?,
// is the final text empty?). Direct 1:1 port of
// packages/sdk-ios/Sources/EverframeReporterUI/Annotation/TextCommitLogic.swift
// — kept free of any android.*/Compose imports so it stays plain-JVM
// testable (`TextCommitLogicTest.kt`, no Robolectric). The executor
// (`FocusedAnnotation.kt`'s `commitPendingText()`) only executes what this
// decides.
//
// The four outcomes (web QA locks — see AnnotateCanvas.tsx `commitTextEdit`,
// mirrored by iOS's `commitTextEditingIfAny`):
//   new + non-empty        -> append a new TEXT shape, select it, ONE push.
//   new + empty/whitespace  -> cancel silently — NO history entry (a never-
//                              committed placement is not an edit).
//   existing + non-empty    -> patch the shape's text, ONE push.
//   existing + now-empty    -> remove the shape, ONE push (one undo restores
//                              — web QA lock: clearing text deletes, it does
//                              not leave a zero-text shape behind).
package dev.everframe.ui.annotation

/**
 * What `commitPendingText()` should do with the in-flight editor's final
 * value. `existingId == null` means the session was placing a NEW text
 * (never yet in `annotations`); non-null means it was re-editing an
 * already-committed TEXT shape.
 */
sealed class TextCommitAction {
    object AppendNew : TextCommitAction()
    object Cancel : TextCommitAction()
    data class Patch(val id: AnnotationId) : TextCommitAction()
    data class Delete(val id: AnnotationId) : TextCommitAction()
}

/**
 * Pure commit-decision function. [trimmedText] need not be pre-trimmed by
 * the caller — whitespace-only (including all-newlines) text is treated as
 * empty regardless, matching web's `value.replace(/\s+$/, '')` + a length-0
 * check (native trims BOTH ends, same as the iOS port, since there is no
 * meaningfully different "trailing-only" trim to preserve here).
 */
fun textCommitAction(existingId: AnnotationId?, trimmedText: String): TextCommitAction {
    val isEmpty = trimmedText.trim().isEmpty()
    return if (existingId != null) {
        if (isEmpty) TextCommitAction.Delete(existingId) else TextCommitAction.Patch(existingId)
    } else {
        if (isEmpty) TextCommitAction.Cancel else TextCommitAction.AppendNew
    }
}
