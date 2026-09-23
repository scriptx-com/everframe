// TextEditOverlay.kt
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Android Task 6 (native report-window parity) — the inline TEXT-tool
// editor. A borderless, auto-growing `BasicTextField` positioned over the
// annotation canvas at the session's image-pixel anchor, mirroring iOS's
// `UITextView` overlay (`FocusedAnnotationViewController.makeTextEditor`).
//
// Deterministic commit (spec lock, iOS-round lesson): this composable never
// decides WHAT to do with the typed text — it only reports live value
// changes upward (`onValueChange`) and asks to commit on `ImeAction.Done`
// (`onCommit`). The actual commit decision/execution lives in
// `FocusedAnnotation.kt`'s `commitPendingText()`, which reads the SAME
// hoisted `TextFieldValue` this field is bound to — so every commit call
// site (pointer-down, Undo/Redo/Clear/Delete, tool-switch, style-row, Done,
// Cancel/back) reads identical live state regardless of whether THIS
// composable is still focused/composed at call time. That is why
// `onCommit` takes no String argument (a deliberate deviation from the
// brief's literal `(String) -> Unit` — see task-6 report "self-review"):
// threading the text through a callback parameter would create a SECOND,
// focus-coupled path to "the current value" alongside the hoisted state,
// reintroducing exactly the focus-loss-ordering race the web/iOS rounds hit.
package dev.everframe.ui.annotation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.everframe.ui.theme.LocalReporterTheme
import kotlin.math.roundToInt

/**
 * One in-flight text-editing session — a NEW placement (`existingId ==
 * null`) or a re-edit of an already-committed TEXT shape. Image-pixel
 * space; `transform` maps it to view space at draw/position time (never
 * baked into the session itself, so it stays valid across rotation/resize).
 */
data class TextEditSession(
    val imageX: Float,
    val imageY: Float,
    val existingId: AnnotationId?,
    val initialText: String,
    val color: Long,
    val fontSize: Float,
)

/**
 * The live inline editor. `value`/`onValueChange` are hoisted (owned by
 * `FocusedAnnotation.kt`) rather than internal `remember`ed state, precisely
 * so `commitPendingText()` can read the CURRENT text from any call site —
 * see the file doc comment above.
 *
 * @param onMeasured reports the field's rendered size (view-px) upward so
 *  the host can compute the IME-overlap shift (Lock 5) as the field grows —
 *  the Android analogue of iOS's `textViewDidChange -> applyKeyboardShiftIfNeeded`.
 */
@Composable
internal fun TextEditOverlay(
    session: TextEditSession,
    transform: ImageTransform,
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    onCommit: () -> Unit,
    modifier: Modifier = Modifier,
    onMeasured: (widthPx: Float, heightPx: Float) -> Unit = { _, _ -> },
) {
    val theme = LocalReporterTheme.current
    val density = LocalDensity.current
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    val fontSizeSp = with(density) { (session.fontSize * transform.scale).toSp() }

    // Focus on mount AND whenever a new session starts (re-editing a
    // different shape re-runs this — `session` is a value class so a
    // different anchor/existingId is a different key). Also explicitly
    // requests the IME show — gaining focus alone is usually enough, but
    // isn't guaranteed on every OEM keyboard/timing, and Lock 5 depends on
    // the keyboard reliably coming up for the shift math to ever run.
    LaunchedEffect(session.imageX, session.imageY, session.existingId) {
        focusRequester.requestFocus()
        keyboardController?.show()
    }

    Box(
        modifier = modifier
            .offset {
                IntOffset(
                    transform.toViewX(session.imageX).roundToInt(),
                    transform.toViewY(session.imageY).roundToInt(),
                )
            }
            .imePadding()
            .onGloballyPositioned { coords ->
                onMeasured(coords.size.width.toFloat(), coords.size.height.toFloat())
            },
    ) {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier
                .widthIn(min = 40.dp)
                .focusRequester(focusRequester),
            textStyle = TextStyle(
                color = Color(session.color),
                fontSize = fontSizeSp,
                lineHeight = fontSizeSp * AnnotationConstants.TEXT_LINE_HEIGHT,
            ),
            cursorBrush = SolidColor(theme.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onCommit() }),
            // Transparent background is the BasicTextField default (no Modifier.background
            // applied) — matches the brief's "transparent background" requirement without
            // extra code. No `.height(...)` constraint — auto-grows with content, no
            // `singleLine = true` — a pasted multi-line value must survive (Lock 7).
        )
    }
}

/**
 * Re-measures a TEXT shape's actual rendered extent using the SAME
 * `android.graphics.Paint` metrics `BakeRenderer.draw`/`drawAnnotationShape`
 * use (ascent/descent + `TEXT_LINE_HEIGHT` line spacing), in image-px
 * directly at the shape's fontSize — no division by `transform.scale`
 * (Lock 4). Called after every text commit and after a resize-handle drag
 * ends on a TEXT shape, so hit-testing/handles (`normalizedBox`/`handles`,
 * which read `width`/`height` for TEXT like every other box kind) never
 * drift from what actually renders.
 *
 * An empty string measures as a single space, mirroring iOS's
 * `measureTextSize` — a freshly-placed, not-yet-typed-into shape still gets
 * a non-zero hit box (moot in practice since a truly-empty commit cancels/
 * deletes rather than landing in `annotations`, but keeps this function
 * total for any future caller).
 */
internal fun restampTextShape(a: Annotation): Annotation {
    if (a.kind != AnnotationKind.TEXT) return a
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        textSize = a.fontSize
    }
    val measured = a.text.ifEmpty { " " }
    val lines = measured.split("\n")
    val width = lines.maxOf { paint.measureText(it) }
    val fm = paint.fontMetrics
    val singleLineHeight = fm.descent - fm.ascent
    val height = singleLineHeight + (lines.size - 1) * a.fontSize * AnnotationConstants.TEXT_LINE_HEIGHT
    return a.copy(width = width, height = height)
}
