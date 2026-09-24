// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ReporterRoot — Android port of the iOS TXReporterViewController layout
// (packages/sdk-ios/Sources/EverframeReporterUI/ReporterViewController.swift).
//
// Layout (matches iOS UI-SPEC 2026-05-11 refactor):
//
//   [Top bar: Cancel | "Report a bug"]
//   ┌─────── Vertical scroll (single, outer) ──────┐
//   │ Screenshot + annotation canvas               │
//   │ Pen / Blur toolbar                           │
//   │ Title field                                  │
//   │ Description text field                       │
//   └──────────────────────────────────────────────┘
//   [Floating Send button — pinned to bottom]
//
// Phase 13 D1: the previous six per-section collapsibles (UI Tree, React
// Tree, Console, Network, Metadata, Extra — each with chevron + inline
// body preview) were replaced by a single IncludeCard with toggle-only
// rows. Task 9 (native report-window parity) then REMOVED that IncludeCard
// entirely — every section always ships now (`ReporterIncludes()` all-true
// hardwire in the Send handler below); `details/IncludeCard.kt` keeps only
// the `ReporterIncludes`/`excludedKeys()` data shape the envelope gating
// contract still reads. Receiver-side previews live downstream in admin
// event detail.
//
// Differences vs the original Android shape:
//   • Floating Send (was inline)
//   • No Include card (Task 9 hardwire — was six collapsibles, then one
//     toggle-only IncludeCard)
//   • Screenshot scales to ~55% of available height (was capped at 360dp)
//   • Focused annotation editor surfaces EditorState.activeTool (Task 5:
//     model-driven, replaces the removed inline Pen/Blur toolbar)
//
// Per UI-SPEC: phone = full-width; tablet = 680dp max-width centered.
package dev.everframe.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.everframe.capture.ScreenshotCapture
import dev.everframe.capture.SensitiveRectRegistry
import dev.everframe.config.BrandingServerConfigSignal
import dev.everframe.config.shouldShowWatermark
import dev.everframe.ui.annotation.Annotation
import dev.everframe.ui.annotation.BakeRenderer
import dev.everframe.ui.annotation.EditorHistory
import dev.everframe.ui.annotation.EditorState
import dev.everframe.ui.annotation.ShotListOps
import dev.everframe.ui.annotation.rememberEditorState
import dev.everframe.ui.details.DiscardConfirmDialog
import dev.everframe.ui.theme.LocalReporterTheme
import dev.everframe.ui.theme.ProvideReporterTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Hard-cap on report title length. Matches Zod protocol cap + every other UI surface. */
private const val TITLE_MAX_CHARS: Int = 200
/** Hard-cap on report description length. Matches Zod protocol cap + every other UI surface. */
private const val DESCRIPTION_MAX_CHARS: Int = 600

/**
 * One screenshot in the report's multi-shot list (Task 7: native
 * report-window parity). Kotlin port of the shape iOS's `ReporterShot`
 * plays against the pure `ShotListOps` branching table.
 *
 * Owns its OWN [annotations] + [history] — each backed by Compose
 * `mutableStateOf` over an immutable value, so per-shot undo/redo is fully
 * isolated: annotate shot 1, switch to shot 2, undo on shot 2 does nothing
 * (its `EditorHistory` never saw shot 1's edits). [FocusedAnnotation]'s
 * shared `EditorState` is seeded from both fields when the editor opens for
 * this shot (see [ReporterRoot]'s preview tap handler) and both are written
 * back on Done, so a shot's undo stack survives repeated open/close cycles
 * within one report session.
 */
internal class ShotState(
    /** Source pixels for this shot — NEVER mutated; every bake copies. */
    val bitmap: android.graphics.Bitmap,
) {
    var annotations: List<Annotation> by mutableStateOf(emptyList())
    var history: EditorHistory by mutableStateOf(EditorHistory())

    /**
     * BakeRenderer.bake(bitmap, annotations) cache. Null while there's
     * nothing to bake, OR invalidated pending a fresh bake after the editor
     * returns (see the FocusedAnnotation `onDone` handler below) — the
     * recompute runs on Dispatchers.Default and lands here when done.
     */
    var bakedPreview: android.graphics.Bitmap? by mutableStateOf(null)

    /**
     * What the strip tile / large thumbnail actually draws: the raw capture
     * when there's nothing to bake, else the cached bake — falling back to
     * the raw bitmap for the brief window between Done and the async
     * recompute landing so a tile is never blank.
     */
    fun previewBitmap(): android.graphics.Bitmap =
        if (annotations.isEmpty()) bitmap else (bakedPreview ?: bitmap)
}

/**
 * Top-level reporter composable. Hosted inside a Material 3 Dialog
 * (see ReporterDialog.kt) but factored as a Composable so instrumented
 * tests can drive it via `composeTestRule.setContent { ReporterRoot(...) }`.
 *
 * @param activity needed for the area-capture and toast paths.
 *                 The compose tree wouldn't have access otherwise.
 */
@Composable
internal fun ReporterRoot(
    capture: ScreenshotCapture.CaptureResult,
    reportCapture: dev.everframe.capture.video.FrozenReportCapture,
    activity: android.app.Activity,
    onSubmit: (
        title: String,
        description: String,
        shots: List<SubmittedShot>,
        includes: dev.everframe.ui.details.ReporterIncludes,
    ) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
    trackText: ((title: String, description: String) -> Unit)? = null,
    // Threaded through from TXReporterPresenter's single consume of pending
    // attachments (iOS parity: TXReporterPresenter.swift:72). Submission
    // re-uses the same snapshot — there is no second consume.
    hostExtra: String? = null,
) {
    var title by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var titleError by remember { mutableStateOf(false) }
    var sending by remember { mutableStateOf(false) }
    // Codex round-2 residual (external review finding 3 fix follow-up):
    // measured height, in px, of the pinned "Floating Send" footer Column
    // below (set via its own Modifier.onSizeChanged) — including that
    // Column's OWN navigationBarsPadding()/imePadding() insets. Used to size
    // the scroll body's bottom content reserve so the reserve can never
    // desync from the footer's actual rendered height again (a fixed dp
    // constant broke once the free-plan watermark row's real height didn't
    // match what the constant assumed, and would break again at any
    // accessibility font scale where sp grows but a dp constant doesn't).
    var footerHeightPx by remember { mutableIntStateOf(0) }
    // Phase 13 D10: brand-styled discard confirmation. Shown when the user
    // taps the top-bar Cancel button with any dirty state (non-empty title /
    // description, or any annotation strokes / blur rects). ReporterDialog
    // also owns its own DiscardConfirmDialog for the system Back gesture
    // path; both call back to `onCancel` once the user confirms.
    var showDiscard by remember { mutableStateOf(false) }
    // Phase 13.1: the modal hosts a static SCREENSHOT thumbnail (not an inline
    // annotation canvas). Tapping it flips `showFocused` true, which slides up
    // the FocusedAnnotation surface. Done hands the annotation list back to
    // the ACTIVE shot (see `shots` below); the thumbnail + strip tile
    // re-render to display that shot's baked composite. The shared
    // EditorState still drives the focused canvas, but Task 7 re-seeds it
    // from the active ShotState on every open and writes both `annotations`
    // and `history` back on Done — each shot owns its own undo stack (Task 7
    // lock 1), not a single session-wide one.
    var showFocused by remember { mutableStateOf(false) }
    // Multi-shot state (Task 7): index 0 is always the open-time capture;
    // ShotListOps.MAX_SHOTS caps additions.
    // `onAdd()` (Task 8) appends a new active shot via the area-capture
    // flow — see `areaCapturing` / `completeAreaCapture` below.
    // Plain `remember` (not `rememberSaveable`) — Bitmaps aren't part of the
    // Bundle-survival contract here, matching the previous `bakedBitmap`.
    val shots = remember {
        mutableStateListOf(ShotState(bitmap = capture.bitmap))
    }
    var activeShotIndex by remember { mutableStateOf(0) }
    // Review finding 2 (Task 7 fix round 1): the fullscreen editor's write-
    // back target must be captured ONCE, at the open transition, not re-read
    // live off `activeShotIndex` on every recomposition — otherwise a shift
    // in `activeShotIndex`/`shots` while the editor is open (shouldn't
    // happen today, but the strip is now also disabled while the editor is
    // up as belt-and-braces — see `enabled = !showFocused` below) could
    // write shot A's annotations into shot B. A direct ShotState REFERENCE
    // (not an index) is the structural fix: it's immune to index shifts,
    // and writing to an orphaned ShotState (deleted mid-edit) is inert since
    // nothing else holds that reference. Set in `openEditorForActiveShot`,
    // cleared by both `onDone` and `onCancel` below.
    var editingShot by remember { mutableStateOf<ShotState?>(null) }
    // Non-null while the delete-confirm AlertDialog is up for shot `index`
    // (only shown when that shot has annotations — ShotListOps.deleteNeedsConfirmation).
    var pendingDeleteIndex by remember { mutableStateOf<Int?>(null) }
    // Task 8: true while AreaCaptureOverlay's own transparent Dialog is
    // showing (strip's onAdd() flips this true). The overlay Dialog is its
    // OWN window, so it's automatically excluded from a PixelCopy of the
    // Activity window — this flag exists purely to make the REPORTER
    // invisible so the user can see (and drag-select over) the host app
    // underneath. Driven via `Modifier.alpha(0f)` on the root content below
    // rather than an `if` — an `if` would DESTROY this composable's
    // subtree, and with it every `remember`-backed Compose state (shots,
    // per-shot annotations/history, includeState, …) the reporter has
    // accumulated so far. `alpha(0f)` keeps the composition (and all that
    // state) alive while visually hiding it; correctness doesn't depend on
    // it also being non-touchable, since AreaCaptureOverlay's fullscreen
    // window sits on top and intercepts every touch at every pixel while
    // it's showing.
    var areaCapturing by remember { mutableStateOf(false) }
    // Review finding 2 (Task 8 fix round 1): generation/cancellation guard
    // for the async area-capture round-trip. `completeAreaCapture` bumps
    // this and closes over the bumped value as `session`; the coroutine
    // only applies its result if `captureSession` is STILL that value once
    // `captureRegion` resolves. The overlay's own `onCancel` below ALSO
    // bumps it, which is what invalidates a capture that's already in
    // flight when Cancel fires — the two bumps share one counter so either
    // side "wins" by being the more recent bump, and a completion that
    // lands after a newer bump (whether from a Cancel or, in principle, a
    // second capture start) is silently discarded rather than appending a
    // stale shot or double-restoring the reporter. A plain Int counter was
    // chosen over tracking/cancelling the launched Job because
    // `ScreenshotCapture.captureRegion` is a single non-cancellable
    // PixelCopy round-trip already wrapped in `txGuardSuspend` — cancelling
    // the Job would abandon the coroutine mid-flight without stopping the
    // underlying PixelCopy callback, so the callback could still land and
    // mutate state after cancellation. Checking a token AFTER the await,
    // rather than trying to interrupt the await, sidesteps that entirely.
    var captureSession by remember { mutableStateOf(0) }
    val annotation = rememberEditorState()
    val scope = rememberCoroutineScope()

    // Removes `shots[index]` per the pure ShotListOps outcome — neighbor
    // selection (min(index, newCount-1), null when empty) comes from there;
    // this function only applies the decision. Deleting every shot is allowed: the large
    // preview collapses (guarded below) and the strip keeps its add tile.
    val performDeleteShot: (Int) -> Unit = performDelete@{ index ->
        if (!shots.indices.contains(index)) return@performDelete
        val outcome = ShotListOps.delete(at = index, count = shots.size)
        shots.removeAt(index)
        activeShotIndex = outcome.newActiveIndex ?: 0
    }
    // Strip's onDelete(i): a blank shot deletes immediately; an annotated
    // shot confirms first via the AlertDialog below (Task 7 lock 3).
    val requestDeleteShot: (Int) -> Unit = requestDelete@{ index ->
        if (!shots.indices.contains(index)) return@requestDelete
        if (ShotListOps.deleteNeedsConfirmation(shots[index].annotations.size)) {
            pendingDeleteIndex = index
        } else {
            performDeleteShot(index)
        }
    }
    // Preview tap → fullscreen editor for the ACTIVE shot. Seeds the shared
    // EditorState's `annotations` + `history` from that shot (Task 7 lock 1
    // — per-shot undo isolation) BEFORE flipping `showFocused`, so
    // FocusedAnnotation's first composition already sees the right stack.
    // `selectedId` is reset too: a stale id from a DIFFERENT shot's session
    // would either dangle (no matching annotation) or, worse, coincidentally
    // collide with an id in the new shot's list.
    val openEditorForActiveShot: () -> Unit = {
        shots.getOrNull(activeShotIndex)?.let { shot ->
            annotation.annotations = shot.annotations
            annotation.history = shot.history
            annotation.selectedId = null
            // Snapshot the write-back target as a REFERENCE at the open
            // transition (review finding 2) — see the `editingShot`
            // declaration above for why this must be a reference, not the
            // live `activeShotIndex`.
            editingShot = shot
        }
        showFocused = true
    }

    // Task 8: strip's onAdd() → AreaCaptureOverlay.onCapture(regionPx). Mirrors
    // TXReporterPresenter's own capture ordering (collect sensitive rects,
    // THEN capture) except scoped to just the dragged region — see
    // ScreenshotCapture.captureRegion. Always restores the reporter
    // (`areaCapturing = false`) whether the region capture succeeded or not;
    // a null result (soft-degrade — bad srcRect, <API-26 device, PixelCopy
    // failure) shows a brief toast and adds no shot, matching Cancel's
    // no-shot outcome.
    val completeAreaCapture: (android.graphics.Rect) -> Unit = { regionPx ->
        // Review finding 2: mint a new session BEFORE launching — see
        // `captureSession`'s declaration above. Captured into `session` so
        // the check below compares against the value at LAUNCH time, not
        // whatever `captureSession` happens to hold when the coroutine
        // resumes.
        captureSession += 1
        val session = captureSession
        scope.launch {
            val sensitiveRects = SensitiveRectRegistry.collectInWindowCoords(activity)
            val result = ScreenshotCapture.captureRegion(activity, regionPx, sensitiveRects)
            if (session != captureSession) {
                // A Cancel (or, in principle, a newer capture) bumped the
                // session while this one was in flight — whoever bumped it
                // already restored `areaCapturing`/reporter visibility, so
                // this stale result is dropped: no shot appended, no state
                // touched. This is the fix for "Cancel restores without a
                // shot, then a shot is appended after" — the shot never
                // gets appended.
                return@launch
            }
            areaCapturing = false
            if (result != null) {
                // Defensive re-check (Task 7 lock: add tile is HIDDEN, not
                // disabled, at ShotListOps.MAX_SHOTS) — guards a race where
                // the cap was hit by some other path while this capture was
                // in flight.
                if (ShotListOps.showsAddTile(shots.size)) {
                    shots.add(ShotState(bitmap = result.bitmap))
                    activeShotIndex = shots.lastIndex
                }
            } else {
                android.widget.Toast.makeText(
                    activity,
                    "Couldn't capture that area — try again",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    // Phase 13 D3: branch on the available width so iPad-class tablets (and
    // Android foldables in Split View) get a two-pane body. BoxWithConstraints
    // is the right primitive at this scale — Compose-Material3
    // WindowSizeClass would be a heavier abstraction for a single 720.dp gate.
    // The Surface lives inside the outer BoxWithConstraints so the 680.dp
    // width cap can be conditionally lifted on tablets.
    val focusManager = LocalFocusManager.current

    // Branding (Android spec 2026-08-26): theme resolution itself now lives
    // in ProvideReporterTheme (dev.everframe.ui.theme), the single provider
    // shared with ReporterDialog's root-external discard dialog (codex
    // round-1 finding 4) — see that file for the collect/resolve/provide
    // details. This is a SECOND, independent collector of the same
    // BrandingServerConfigSignal StateFlow, kept here only for the watermark
    // gate below; StateFlow fans out to every collector so it stays in sync
    // with the one inside ProvideReporterTheme.
    val serverBranding by BrandingServerConfigSignal.flow.collectAsState()
    // Free-plan watermark gate (Step 3 footer) — hoisted here so it's in
    // scope alongside the theme resolution and reused by the footer below.
    val showWatermark = shouldShowWatermark(serverBranding)

    ProvideReporterTheme {
    val theme = LocalReporterTheme.current
    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            // Task 8: made invisible (composition-preserving — see the
            // `areaCapturing` declaration above for why `alpha` and not an
            // `if`) while AreaCaptureOverlay's own Dialog window is up, so
            // the user can see the host app underneath through the (still
            // showing) reporter Dialog's transparent window chrome.
            .alpha(if (areaCapturing) 0f else 1f),
    ) {
        val isTablet = maxWidth >= 720.dp
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .then(if (isTablet) Modifier else Modifier.widthIn(max = 680.dp)),
            color = theme.bg,
            // Task 10 (quiet-instrument): this Surface fills the whole
            // Dialog window edge-to-edge and hosts the sheet-handle mock at
            // its top — it reads as a bottom sheet, not a centered card, so
            // only the top corners take the web modal radius
            // (--txx-radius-modal: 18px). Bottom stays square, flush with
            // the physical screen edge.
            shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp),
        ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                // Tap outside a text field dismisses the soft keyboard: clearing
                // focus closes the IME and deselects the field. Taps on the
                // OutlinedTextFields are consumed by them, so this only fires for
                // taps on empty / non-input regions of the form.
                .pointerInput(Unit) {
                    detectTapGestures(onTap = { focusManager.clearFocus() })
                },
        ) {
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxSize()
                    // Review finding: with ReporterDialog's Dialog now
                    // decorFitsSystemWindows = false, this Window no longer
                    // auto-avoids the status bar or the keyboard, so the
                    // composer must inset itself explicitly. Scoped to THIS
                    // container (not the shared root Box/Surface) so the
                    // sibling FocusedAnnotation fullscreen takeover — which
                    // wants to draw edge-to-edge — is unaffected.
                    // statusBarsPadding(): keeps the sheet handle + top bar
                    // ("Cancel · Report a bug") clear of the status bar.
                    //
                    // NO imePadding() here, deliberately. The keyboard inset
                    // is accounted for EXACTLY ONCE in this tree, by the
                    // pinned Send footer below — and the scroll body already
                    // inherits that through `footerReserve`, which is the
                    // footer's OWN measured height WITH its
                    // navigationBarsPadding()/imePadding() baked in.
                    //
                    // Adding imePadding() here as well subtracted the
                    // keyboard height a second time: the viewport became
                    // screen - status - ime - (sendRow + nav + ime), which on
                    // a ~800dp phone with a ~300dp keyboard leaves ~0dp of
                    // scrollable body once the top bar is drawn. Focusing the
                    // description field then had nowhere to scroll to and the
                    // field rendered under the opaque Send footer — reported
                    // on-device as "the page jumps up and something covers
                    // the input; I can't see what I'm typing".
                    //
                    // Without it the scroll viewport is
                    // screen - status - (sendRow + max(nav, ime)), i.e. the
                    // strip of screen actually visible between the top bar
                    // and the footer, which is what Compose's
                    // bring-focused-field-into-view needs it to be.
                    .statusBarsPadding(),
            ) {
                val imageMaxHeight = maxHeight * 0.55f
                val scrollState = rememberScrollState()
                // Brand-aware field surface — Bg3 @ 0.6 alpha on the deep
                // page with a Hair border + Accent cursor/focus. Lifted out
                // of the scroll body so both phone and tablet branches can
                // share the same OutlinedTextField colors without duplication.
                val inputColors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = theme.accent,
                    unfocusedBorderColor = theme.hair,
                    focusedLabelColor = theme.accent,
                    unfocusedLabelColor = theme.ink3,
                    cursorColor = theme.accent,
                    focusedContainerColor = theme.bg3.copy(alpha = 0.6f),
                    unfocusedContainerColor = theme.bg3.copy(alpha = 0.6f),
                    focusedTextColor = theme.ink,
                    unfocusedTextColor = theme.ink,
                )
                val navBottom = with(LocalDensity.current) {
                    WindowInsets.navigationBars.getBottom(this).toDp()
                }
                // Measured footer reserve (Android spec 2026-08-26, external
                // review finding 3; codex round-2 residual). A constant
                // (108.dp free-plan / 80.dp paid) previously stood in for the
                // pinned footer's real height, but desynced from it: the
                // free-plan watermark row's Text inherited MaterialTheme's
                // default 24sp line height, so the row rendered ~36dp, not
                // the ~28dp the constant assumed — and any accessibility
                // font-scale bump would only widen that gap, since sp grows
                // with scale but a dp constant doesn't. `footerHeightPx`
                // (set via onSizeChanged on the pinned "Floating Send" Column
                // below) is the footer's ACTUAL measured height and already
                // includes that Column's own navigationBarsPadding()/
                // imePadding() insets — so it can never drift from what's
                // actually rendered, regardless of watermark visibility,
                // line-height, or font scale. `footerHeightPx == 0` only on
                // the very first composition (before that Column has
                // measured once); fall back to the old constant so the
                // layout doesn't jump from a zero reserve to the real one.
                val footerReserve = if (footerHeightPx == 0) {
                    80.dp + navBottom
                } else {
                    with(LocalDensity.current) { footerHeightPx.toDp() }
                }
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        // Bottom padding reserves room for the floating Send
                        // overlay so the last section isn't hidden behind it.
                        // `footerReserve` is the pinned footer's OWN measured
                        // height (see onSizeChanged below) once available, and
                        // ALREADY includes its navigationBarsPadding()/
                        // imePadding() insets — don't add navBottom again
                        // here in that branch, only in the first-composition
                        // fallback above, or the inset double-counts.
                        //
                        // For the same reason no ancestor of this Column may
                        // apply imePadding(): this reserve IS the composer's
                        // keyboard avoidance. See the BoxWithConstraints
                        // above.
                        .padding(bottom = footerReserve),
                ) {
                    // ---------------- Sheet handle (mock .sheet::before) ----------------
                    // 40x5 pill, ink-3 @ 50% alpha, centered above the top bar.
                    Box(
                        modifier = Modifier
                            .padding(top = 8.dp, bottom = 4.dp)
                            .size(width = 40.dp, height = 5.dp)
                            .clip(RoundedCornerShape(99.dp))
                            .background(theme.ink3.copy(alpha = 0.5f))
                            .align(Alignment.CenterHorizontally),
                    )

                    // ---------------- Top bar ----------------
                    // grid-template-columns: 1fr auto 1fr; padding 26/16/14/16
                    // → Row with weighted left/right cells around centered title.
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(theme.bg2)
                            .padding(start = 16.dp, end = 16.dp, top = 26.dp, bottom = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                            TextButton(
                                onClick = {
                                    // Phase 13 D10: dirty-check before cancel
                                    // — non-empty text OR any in-progress
                                    // annotation triggers the brand dialog.
                                    val dirty = title.isNotBlank() ||
                                        description.isNotBlank() ||
                                        shots.any { it.annotations.isNotEmpty() }
                                    if (dirty) showDiscard = true else onCancel()
                                },
                                colors = ButtonDefaults.textButtonColors(contentColor = theme.accent),
                                contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp),
                            ) {
                                Text("Cancel")
                            }
                        }
                        Text(
                            "Report a bug",
                            style = MaterialTheme.typography.titleMedium.copy(
                                fontSize = 16.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = theme.ink,
                            ),
                        )
                        // Empty trailing cell preserves 1fr/auto/1fr centering.
                        Box(modifier = Modifier.weight(1f))
                    }
                    HorizontalDivider(color = theme.hair)

                    // ---------------- Scroll body ----------------
                    // Phase 13 D3: phone keeps the single-column vertical
                    // stack; tablet (maxWidth >= 720.dp) splits into a two-
                    // column body — canvas + toolbar on the left, title +
                    // description + Include card on the right. The top bar
                    // (above) and floating Send footer (below, sibling Box)
                    // continue to span both columns.
                    if (isTablet) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f)
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            // Left column — strip + thumbnail block (Phase
                            // 13.1 removed the inline canvas + Pen/Blur
                            // toolbar in favor of a tap-to-annotate
                            // thumbnail; Task 7 adds the multi-shot strip
                            // above it, still inside the thumbnail column on
                            // tablet per the brief's tablet-layout lock).
                            Column(
                                modifier = Modifier
                                    .weight(1.2f)
                                    .fillMaxWidth(),
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                ScreenshotStrip(
                                    shots = shots,
                                    activeIndex = activeShotIndex,
                                    onSelect = { activeShotIndex = it },
                                    onDelete = requestDeleteShot,
                                    onAdd = {
                                        // Task 8: defensive re-check — the add
                                        // tile itself is already hidden at the
                                        // cap (ShotListOps.showsAddTile), but
                                        // guard here too against a stray tap
                                        // racing a state update.
                                        if (ShotListOps.showsAddTile(shots.size)) {
                                            areaCapturing = true
                                        }
                                    },
                                    // Review finding 2: belt-and-braces —
                                    // the strip is inert while the fullscreen
                                    // editor is open, on top of the
                                    // `editingShot` reference snapshot.
                                    enabled = !showFocused,
                                )
                                // Deleting every shot is allowed (Task 7 lock
                                // 3) — the large preview simply collapses;
                                // the strip above still shows its add tile.
                                if (shots.isNotEmpty()) {
                                    ScreenshotThumbnail(
                                        sourceBitmap = shots[activeShotIndex].bitmap,
                                        bakedBitmap = shots[activeShotIndex].bakedPreview,
                                        onTap = openEditorForActiveShot,
                                    )
                                }
                            }

                            // Right column — title + description + Include
                            // card. Scrolls independently so the canvas stays
                            // pinned on the left when the user types into a
                            // long description.
                            Column(
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxWidth()
                                    .verticalScroll(scrollState),
                                verticalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                ReporterTitleField(
                                    value = title,
                                    onValueChange = { input ->
                                        val clamped = input.take(TITLE_MAX_CHARS)
                                        title = clamped
                                        if (titleError && clamped.isNotBlank()) titleError = false
                                        trackText?.invoke(clamped, description)
                                    },
                                    isError = titleError,
                                    colors = inputColors,
                                )
                                ReporterDescriptionField(
                                    value = description,
                                    onValueChange = { input ->
                                        val clamped = input.take(DESCRIPTION_MAX_CHARS)
                                        description = clamped
                                        trackText?.invoke(title, clamped)
                                    },
                                    colors = inputColors,
                                )
                                Spacer(Modifier.height(8.dp))
                            }
                        }
                    } else {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .verticalScroll(scrollState)
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            // Task 7: strip lives above the preview in the
                            // scroll body on phone (brief's phone-layout
                            // lock), same components/callbacks as tablet.
                            ScreenshotStrip(
                                shots = shots,
                                activeIndex = activeShotIndex,
                                onSelect = { activeShotIndex = it },
                                onDelete = requestDeleteShot,
                                onAdd = {
                                    // Task 8: defensive re-check — the add
                                    // tile itself is already hidden at the
                                    // cap (ShotListOps.showsAddTile), but
                                    // guard here too against a stray tap
                                    // racing a state update.
                                    if (ShotListOps.showsAddTile(shots.size)) {
                                        areaCapturing = true
                                    }
                                },
                                // Review finding 2: belt-and-braces — the
                                // strip is inert while the fullscreen editor
                                // is open, on top of the `editingShot`
                                // reference snapshot.
                                enabled = !showFocused,
                            )
                            if (shots.isNotEmpty()) {
                                ScreenshotThumbnail(
                                    sourceBitmap = shots[activeShotIndex].bitmap,
                                    bakedBitmap = shots[activeShotIndex].bakedPreview,
                                    onTap = openEditorForActiveShot,
                                )
                            }
                            ReporterTitleField(
                                value = title,
                                onValueChange = { input ->
                                    val clamped = input.take(TITLE_MAX_CHARS)
                                    title = clamped
                                    if (titleError && clamped.isNotBlank()) titleError = false
                                    trackText?.invoke(clamped, description)
                                },
                                isError = titleError,
                                colors = inputColors,
                            )
                            ReporterDescriptionField(
                                value = description,
                                onValueChange = { input ->
                                    val clamped = input.take(DESCRIPTION_MAX_CHARS)
                                    description = clamped
                                    trackText?.invoke(title, clamped)
                                },
                                colors = inputColors,
                            )
                            Spacer(Modifier.height(8.dp))
                        }
                    }
                }
            }

            // ---------------- Floating Send (pinned bottom) ----------------
            // Mock .footer: Bg2 floor + hairline top + flat/subtle amber Send
            // (Task 10 quiet-instrument pass — matches web's `.txx-btn-primary`:
            // solid accent fill, `--txx-accent-fg` text, no gradient, no
            // colored glow). The shadow is kept but neutralized to black so it
            // reads as ordinary elevation, not a brand-colored lift.
            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    // Codex round-2 residual: report this Column's measured
                    // height up into `footerHeightPx` so the scroll body's
                    // bottom reserve above can size itself off the ACTUAL
                    // footer, not a constant. Placed BEFORE
                    // navigationBarsPadding()/imePadding() below (i.e.
                    // wrapping them in the modifier chain) so the reported
                    // size already includes both insets — the scroll body's
                    // reserve then must NOT add navBottom again on top of it.
                    .onSizeChanged { footerHeightPx = it.height }
                    .background(theme.bg2)
                    // Review finding: background is applied BEFORE these so
                    // the Bg2 floor still bleeds to the physical bottom edge
                    // (behind the nav bar / gesture pill) while the button
                    // row inside respects the safe area. navigationBarsPadding
                    // keeps Send clear of the 3-button/gesture nav bar when
                    // the keyboard is closed; imePadding lifts it above the
                    // keyboard when a text field is focused — chaining both
                    // is the standard Compose pattern for a pinned bottom
                    // bar that must dodge either inset. Needed now that
                    // ReporterDialog's Dialog no longer auto-resizes for
                    // decorFitsSystemWindows = false.
                    .navigationBarsPadding()
                    .imePadding(),
            ) {
                HorizontalDivider(color = theme.hair)
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Button(
                        enabled = !sending,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(50.dp)
                            .shadow(
                                elevation = 6.dp,
                                shape = RoundedCornerShape(10.dp),
                                ambientColor = Color.Black,
                                spotColor = Color.Black,
                            )
                            .clip(RoundedCornerShape(10.dp))
                            .background(theme.accent),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            // Container is transparent so the flat fill applied
                            // via Modifier.background shows through.
                            containerColor = Color.Transparent,
                            contentColor = theme.accentFg,
                            disabledContainerColor = Color.Transparent,
                            disabledContentColor = theme.accentFg.copy(alpha = 0.7f),
                        ),
                        onClick = {
                            if (title.isBlank()) {
                                titleError = true
                                return@Button
                            }
                            if (sending) return@Button
                            sending = true
                            val capturedTitle = title.trim()
                            val capturedDescription = description.trim()
                            // Task 9: ship ALL shots (order preserved), not
                            // just the active one. Each shot hands off its
                            // RAW source bitmap + its own annotation list —
                            // NEVER the UI's `bakedPreview` cache — so
                            // submitBaked bakes fresh per shot on
                            // Dispatchers.Default (DEFE-02-wrapped) and the
                            // wire never depends on preview-cache state.
                            // Include hardwire (Task 9): the IncludeCard UI
                            // was removed — every section always ships
                            // (`ReporterIncludes()` all-true; `excluded`
                            // stays `[]`).
                            val submittedShots = shots.map { shot ->
                                SubmittedShot(
                                    bitmap = shot.bitmap,
                                    annotations = shot.annotations,
                                )
                            }
                            onSubmit(
                                capturedTitle,
                                capturedDescription,
                                submittedShots,
                                dev.everframe.ui.details.ReporterIncludes(),
                            )
                        },
                    ) {
                        Text(if (sending) "Sending…" else "Send report")
                    }
                }

                // Free-plan watermark (Android spec 2026-08-26): shown unless
                // the LATEST server config confirms paid (watermark == false).
                if (showWatermark) {
                    Box(
                        modifier = Modifier.fillMaxWidth(),
                        contentAlignment = Alignment.Center,
                    ) {
                        PoweredByEverframe()
                    }
                }
            }

            // Phase 13.1: thumbnail-driven fullscreen takeover. AnimatedVisibility
            // slides the surface up from the bottom-edge so the user sees the
            // modal recede underneath. Task 7 fix round 1 (review finding 2):
            // the editor targets `editingShot` — a ShotState REFERENCE
            // snapshotted once at the open transition in
            // `openEditorForActiveShot`, NOT a live re-read of
            // `activeShotIndex`/`shots`. This is structural, not just
            // defensive: an index-based read would be wrong if
            // `activeShotIndex`/`shots` changed while the editor was open
            // (Done would write shot A's annotations into shot B). A direct
            // reference is immune to index shifts, and — combined with
            // `enabled = !showFocused` on both ScreenshotStrip call sites
            // above — the strip can no longer mutate `shots` while the
            // editor is up in the first place.
            AnimatedVisibility(
                visible = showFocused && editingShot != null,
                enter = slideInVertically(initialOffsetY = { it }),
                exit = slideOutVertically(targetOffsetY = { it }),
            ) {
                val shot = editingShot
                if (shot != null) {
                    FocusedAnnotation(
                        // Task 5: annotations are model-driven and persist in
                        // `annotation` across open/close cycles, so the live
                        // canvas always draws on top of the ORIGINAL capture —
                        // no more "bake on top of a previous bake" layering.
                        // Task 7: "original capture" now means the EDITING
                        // shot's own source bitmap, not always `capture.bitmap`.
                        sourceBitmap = shot.bitmap,
                        state = annotation,
                        onCancel = {
                            showFocused = false
                            editingShot = null
                        },
                        onDone = { newAnnotations ->
                            // Task 7 lock 1: write BOTH the annotation list
                            // and the undo/redo history back to the exact
                            // ShotState captured when the editor opened
                            // (`shot`, from `editingShot` — see the
                            // AnimatedVisibility comment above). Writing to
                            // an orphaned ShotState (deleted mid-edit, were
                            // that ever reachable) is inert: nothing else
                            // references it.
                            shot.annotations = newAnnotations
                            shot.history = annotation.history
                            // Invalidate the cache; recompute off the main
                            // thread so Done never blocks on a bake.
                            shot.bakedPreview = null
                            // Review finding 1: guard the async write-back
                            // with a generation token so a double edit-Done
                            // race can't ship a stale composite. `bakedFor`
                            // captures the exact list THIS bake is computed
                            // from; `List<Annotation>` is immutable and
                            // `shot.annotations` is only ever REASSIGNED
                            // (never mutated in place), so reference equality
                            // between `shot.annotations` and `bakedFor` at
                            // write-back time is a valid "am I still the
                            // latest bake" check — if a newer Done already
                            // landed (and reassigned `shot.annotations` to a
                            // different list instance) while this bake was
                            // still running on Dispatchers.Default, the write
                            // is dropped instead of clobbering the newer one.
                            val bakedFor = newAnnotations
                            scope.launch {
                                if (bakedFor.isNotEmpty()) {
                                    val baked = withContext(Dispatchers.Default) {
                                        BakeRenderer.bake(shot.bitmap, bakedFor)
                                    }
                                    if (shot.annotations === bakedFor) {
                                        shot.bakedPreview = baked
                                    }
                                }
                            }
                            showFocused = false
                            editingShot = null
                        },
                        imageWidth = shot.bitmap.width.toFloat(),
                        imageHeight = shot.bitmap.height.toFloat(),
                    )
                }
            }

            // Task 7 lock 3: delete-confirm AlertDialog — shown only when
            // the shot being deleted has annotations (ShotListOps.deleteNeedsConfirmation,
            // applied by requestDeleteShot above). Sibling-of-Send so the
            // dialog Window lifts above both the scroll body and the
            // floating footer, same as the discard-confirm overlay below.
            pendingDeleteIndex?.let { index ->
                AlertDialog(
                    onDismissRequest = { pendingDeleteIndex = null },
                    containerColor = theme.bg2,
                    titleContentColor = theme.ink,
                    textContentColor = theme.ink3,
                    title = { Text("Delete screenshot?") },
                    text = { Text("Its annotations will be deleted with it.") },
                    confirmButton = {
                        TextButton(onClick = {
                            performDeleteShot(index)
                            pendingDeleteIndex = null
                        }) {
                            Text("Delete", color = theme.hot)
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { pendingDeleteIndex = null }) {
                            Text("Cancel", color = theme.ink2)
                        }
                    },
                )
            }

            // Phase 13 D10: brand-styled discard confirmation overlay.
            // Sibling-of-Send so the dialog Window lifts above both the
            // scroll body and the floating footer.
            if (showDiscard) {
                DiscardConfirmDialog(
                    onKeepEditing = { showDiscard = false },
                    onDiscard = {
                        showDiscard = false
                        onCancel()
                    },
                )
            }
        }
        }
    }

    // Task 8: AreaCaptureOverlay is its OWN Dialog/window — a `Dialog`
    // composable doesn't participate in the surrounding layout tree, so
    // this sits as a sibling of the BoxWithConstraints above rather than
    // nested inside it. Being composed AFTER (and only while
    // `areaCapturing`), its window is added on top of the already-showing
    // (now alpha-0) reporter Dialog window, and — being fullscreen and
    // touchable — intercepts every touch itself, so the invisible reporter
    // window underneath never receives stray input while this is up.
    if (areaCapturing) {
        AreaCaptureOverlay(
            onCapture = completeAreaCapture,
            onCancel = {
                // Review finding 2: bump the session so a capture that's
                // already in flight (should be rare — the overlay's own
                // Cancel button is disabled mid-capture, see
                // AreaCaptureOverlay's `capturing` guard — but this also
                // covers a Cancel that raced in before the overlay's guard
                // engaged, or any future caller of `onCancel`) has its
                // eventual result discarded instead of appending a shot
                // after the user already cancelled.
                captureSession += 1
                areaCapturing = false
            },
        )
    }
    } // ProvideReporterTheme
}

// ---- Shared sub-composables -------------------------------------------------
//
// Lifted out of ReporterRoot so the phone (single-column) and tablet
// (two-column) branches can call them at the right point in the layout
// without duplicating their body. Each is a thin wrapper around the same
// `OutlinedTextField` / image-card / canvas markup that previously lived
// inline.

/**
 * Phase 13.1 thumbnail block. Renders an eyebrow label, a tap-target image
 * card (with expand-corner badge + bottom "Tap to annotate" hint pill), and
 * accepts the latest baked composite — if non-null, the thumbnail shows the
 * baked image; otherwise it shows the raw screenshot.
 *
 * Sizing: fills the modal width with a fixed height (160.dp phone /
 * 320.dp tablet) and crops the image to fit. Mirrors iOS, which uses
 * scaleAspectFill on a thumbnail container constrained to full width
 * × cap height. A portrait phone screenshot inside the wide container
 * gets center-cropped to a horizontal slice — same as iOS.
 */
@Composable
private fun ScreenshotThumbnail(
    sourceBitmap: android.graphics.Bitmap,
    bakedBitmap: android.graphics.Bitmap?,
    onTap: () -> Unit,
) {
    val theme = LocalReporterTheme.current
    val isTablet = LocalConfiguration.current.smallestScreenWidthDp >= 600
    val thumbnailHeight = if (isTablet) 320.dp else 160.dp

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = "SCREENSHOT · TAP TO ANNOTATE",
            style = TextStyle(
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Medium,
                fontSize = 11.sp,
                letterSpacing = 0.6.sp,
                color = theme.ink3,
            ),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(thumbnailHeight)
                .clip(RoundedCornerShape(12.dp))
                .border(1.dp, theme.accent.copy(alpha = 0.35f), RoundedCornerShape(12.dp))
                .drawBehind {
                    // Accent-tinted bottom shadow stand-in: 2px slab at the
                    // bottom edge, matches `0 2px 0 color-mix(accent 25%)`.
                    drawRect(
                        color = theme.accent.copy(alpha = 0.25f),
                        topLeft = Offset(0f, size.height),
                        size = Size(size.width, 2f),
                    )
                }
                .clickable(
                    onClickLabel = "Annotate screenshot, double-tap to open editor",
                    role = Role.Button,
                    onClick = onTap,
                )
                .semantics {
                    contentDescription = "Annotate screenshot, double-tap to open editor"
                },
        ) {
            Image(
                bitmap = (bakedBitmap ?: sourceBitmap).asImageBitmap(),
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
            // Expand-corner badge top-right (Unicode glyph stands in for the
            // expand-arrows SVG; Phase 13 CONTEXT D6 forbids new icon deps).
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(8.dp)
                    .size(30.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(theme.bg2.copy(alpha = 0.80f))
                    .border(1.dp, theme.accent.copy(alpha = 0.35f), RoundedCornerShape(8.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    "⤢",
                    color = theme.accent,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            // Phase 13.1 follow-up: the "Tap to annotate" hint pill was
            // removed — at the new 160dp/320dp thumbnail caps the pill text
            // wrapped badly on portrait screenshots. The expand badge in
            // the top-right corner is enough tap-target affordance on its
            // own, and the eyebrow label above ("SCREENSHOT · TAP TO
            // ANNOTATE") already names the action.
        }
    }
}

@Composable
private fun ReporterTitleField(
    value: String,
    onValueChange: (String) -> Unit,
    isError: Boolean,
    colors: androidx.compose.material3.TextFieldColors,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text("Title *") },
        isError = isError,
        supportingText = if (isError) {
            { Text("Title is required") }
        } else null,
        singleLine = true,
        colors = colors,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun ReporterDescriptionField(
    value: String,
    onValueChange: (String) -> Unit,
    colors: androidx.compose.material3.TextFieldColors,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text("What happened?") },
        colors = colors,
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 96.dp, max = 240.dp),
    )
}
