// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 13.1 — EverframeReporter Annotation Redesign · Plan 13.1-01 (Wave 1)
// Task 5 (native report-window parity): the editor is now MODEL-DRIVEN.
// `annotations: [Annotation]` (Annotation/AnnotationModel.swift) is the one
// source of truth for every shape; `EditorHistory` is a snapshot undo/redo
// stack over that array; `ImageTransform` is the one view↔image mapping.
// The three per-tool state machines (PenTool / BlurTool / ArrowTool) and the
// dead `AnnotationCanvasView` are deleted — their gestures are remapped onto
// the model (pen draws `.pen`, redact draws `.blur`, arrow draws `.arrow`,
// plus the new highlighter/rect/ellipse kinds). Selection/move/resize
// (`.pointer`) and text authoring (`.text`) gestures arrive in Tasks 6/8 —
// those tools are in the palette but draw nothing yet.
//
// Layout (mock: annotation-preview.html · Native-phone / Native-tablet):
//
//   [Cancel  ·  EDIT SCREENSHOT  ·  Done]                  (top bar)
//   ┌─ canvas (full-bleed) ────────────────────────────┐
//   │                                  [Undo] [Redo]   │  (history cluster)
//   │                                                  │
//   │   screenshot + live-preview overlay              │
//   │                                                  │
//   │ [Ptr][Pen][Hi][Rect][Elli][Arw][Txt][Rdt] │ [○] │ [Clear]  (palette)
//   └──────────────────────────────────────────────────┘
//
// History (Phase 13.1 CONTEXT § "History cluster", now snapshot-based):
// `EditorHistory.push(snapshot:)` records the array BEFORE a commit; undo/redo
// swap the whole array. Clear pushes a snapshot then empties `annotations`.
//
// Done flow (CONTEXT § "Thumbnail re-render contract"): the host
// (ReporterViewController) now owns baking — `onDone` hands back the raw
// `[Annotation]` (+ report targets) and the host calls `BakeRenderer.bake`
// itself at submit/thumbnail-refresh time. This VC never bakes.
#if canImport(UIKit) && !os(tvOS)
import UIKit
import CoreGraphics
import EverframeProtocol
import EverframeKit

@MainActor
public final class FocusedAnnotationViewController: UIViewController {

    // MARK: - Public API

    /// Called when the user taps Done. Delivers the full annotation array
    /// (image-pixel space). The host owns baking (BakeRenderer.bake) and
    /// per-shot persistence — this VC is a pure editing surface over whatever
    /// it was seeded with.
    public var onDone: ((_ annotations: [Annotation]) -> Void)?

    /// Called when the user taps Cancel. The host should NOT re-render the
    /// thumbnail — committed state is rolled back to whatever was passed in.
    public var onCancel: (() -> Void)?

    /// Injected by the host (ReporterViewController.presentFocusedAnnotation)
    /// immediately after construction, before `present(vc, animated:)` —
    /// viewDidLoad (where this and the propagated `overlay.palette` are
    /// read) runs at presentation, strictly after that assignment. NOTE:
    /// this type ALSO declares `private static let palette` (the swatch
    /// popover's fixed color list, line ~224) — a static member and an
    /// instance member may share a name in Swift (different namespaces:
    /// `Self.palette` vs `self.palette`/bare `palette` in instance scope).
    /// The only place this collides at the SOURCE level is viewDidLoad,
    /// which shadows this property with an unrelated local `let palette =
    /// makePalettePill()` (a UIView) — verified every access to the
    /// instance's `palette` inside viewDidLoad happens BEFORE that local
    /// declaration (`view.backgroundColor = palette.bg` and
    /// `overlay.palette = palette`), so the shadow never observes the wrong
    /// value.
    var palette: ResolvedPalette = .brand

    // MARK: - Inputs

    private let sourceImage: UIImage

    // MARK: - Model state (Task 5 — image-pixel-space, host-seeded/returned)

    /// Image-pixel-space model. Seeded by the host per shot; handed back on
    /// Done.
    var annotations: [Annotation] = [] { didSet { overlay.setNeedsDisplay() } }
    /// Snapshot undo/redo over `annotations`.
    var history = EditorHistory() { didSet { updateHistoryButtons() } }
    var selectedId: AnnotationId? {
        didSet {
            overlay.setNeedsDisplay()
            updateTrashButtonState()
            refreshStyleRow()
        }
    }
    /// Rebuilt on layout — THE view↔image mapping (spec: one transform rule).
    var transform = ImageTransform(imageSize: .zero, viewSize: .zero)
    /// The shape being drawn by the current gesture; committed into
    /// `annotations` on gesture end (if it clears the min-drag floor),
    /// discarded otherwise. nil when no gesture is in progress.
    var inProgressAnnotation: Annotation?

    /// Image-pixel-space origin of the current drag — used by the box tools
    /// (.rect/.ellipse/.redact) to compute the in-progress rect on each move.
    private var dragOrigin: CGPoint?

    // MARK: - Touch session (Task 6 — tap-select / move / resize / draw)
    //
    // Replaces the old direct tool-dispatch in the gesture handlers. A touch
    // starts `.pending` (undecided — could become a tap, a drag-select-move,
    // a resize, or a draw) until it either lifts (tap) or exceeds `slopPt` in
    // view space, at which point rule 2 below resolves it into exactly one
    // of `.moving` / `.resizing` / `.drawing`, or leaves it `.pending`
    // (pointer tool dragging over empty canvas — intentionally inert).
    private enum TouchSession {
        case idle
        /// Undecided until slop (6pt view-space) is exceeded.
        case pending(startView: CGPoint, startImage: CGPoint, onHandle: HandleKind?, onShape: AnnotationId?)
        case drawing                                  // inProgressAnnotation is live
        case moving(id: AnnotationId, lastImage: CGPoint, pushed: Bool)
        case resizing(id: AnnotationId, handle: HandleKind, pushed: Bool)
    }
    private var session: TouchSession = .idle
    private let slopPt: CGFloat = 6

    // MARK: - Active tool + stroke style

    /// Active tool — toggled by the bottom palette pill. Initial = .pen so
    /// a first drag draws a stroke without the user having to tap anything.
    private var activeTool: AnnotationTool = .pen {
        didSet {
            refreshPaletteSelection()
            refreshStyleRow()
        }
    }

    /// Stroke color for new pen/highlighter/rect/ellipse/arrow shapes (ARGB —
    /// the model's native color representation; see AnnotationConstants.
    /// penColors). Existing committed shapes keep their original color.
    private var currentColor: UInt32 = AnnotationConstants.penColors[0]
    /// Stroke thickness for new shapes. Task 5 does not add a thickness
    /// picker to the palette (out of scope); this mirrors the old PenTool
    /// default line width.
    private var currentThickness: CGFloat = AnnotationConstants.penThicknesses[1]
    /// Font size (image-px) for new `.text` shapes — web `fontSize` state
    /// default (TEXT_FONT_SIZES[1] = 24).
    private var currentFontSize: CGFloat = AnnotationConstants.textFontSizes[1]

    // MARK: - Inline text editing (Task 8)

    /// The live UITextView overlay, or nil when no text-editing session is
    /// in progress. Its presence (not `editingAnnotationId`) is what "a
    /// session is active" means — a NEW placement has a live `textEditor`
    /// but `editingAnnotationId == nil` until (if ever) it commits. NOT
    /// `private` (like `editingAnnotationId` above) — TextEditCommitGuardTests
    /// (Fix round 1) drives a real in-flight edit by setting `.text` directly
    /// on this, then invoking the real `undoTapped`/`redoTapped` button
    /// targets, rather than re-implementing the commit logic in the test.
    var textEditor: UITextView?
    /// nil while placing a NEW text (never yet in `annotations`); set to the
    /// shape's id when re-editing an already-committed `.text` shape. NOT
    /// `private` (like `annotations`/`selectedId`/`transform` above) — the
    /// nested `AnnotationOverlayView.draw(_:)` reads it to skip rendering
    /// the shape while its UITextView overlay is up (item 3).
    var editingAnnotationId: AnnotationId?
    /// Image-pixel top-left anchor for the session — a NEW text's tap point,
    /// or an existing text's current `(x, y)`. The anchor never moves while
    /// typing; only width/height grow around it.
    private var textEditOrigin: CGPoint?
    /// Most recent keyboard show/change notification — replayed by
    /// `applyKeyboardShiftIfNeeded` when the editor's own size changes
    /// (typing) without a fresh keyboard notification arriving.
    private var lastKeyboardChangeNotification: Notification?

    // MARK: - Views

    private let canvasContainer = UIView()
    /// Test seam: used by EditorFirstLayoutTests to verify first-layout
    /// transform precision (image fits to window on initial layout, not just
    /// after interaction).
    var imageView: UIImageView { _imageView }
    private let _imageView = UIImageView()
    private let overlay = AnnotationOverlayView()

    // Palette + history controls — kept as ivars so refresh helpers can
    // restyle them when active-tool or undo/redo state changes.
    private var pointerButton: UIButton!
    private var penButton: UIButton!
    private var highlighterButton: UIButton!
    private var rectButton: UIButton!
    private var ellipseButton: UIButton!
    private var arrowButton: UIButton!
    private var textButton: UIButton!
    private var redactButton: UIButton!
    private var swatchView: UIView!
    private var swatchButton: UIButton!
    /// Trash — deletes the selected shape. Enabled iff `selectedId != nil`.
    private var trashButton: UIButton!
    /// Thickness steps (web PEN_THICKNESSES parity: 2/4/8). Restyles the
    /// selection live when one exists, else sets the default for new shapes.
    /// Hidden whenever `textSizeControl` is shown (mutually exclusive — web
    /// AnnotateCanvas.tsx style row ternary at `tool === 'text' ||
    /// selectedShape?.kind === 'text'`).
    private var thicknessControl: UISegmentedControl!
    /// S/M/L text-size steps (web TEXT_FONT_SIZES parity: 16/24/36 image-px).
    /// Visible instead of `thicknessControl` iff the active tool is `.text`
    /// or the current selection is a `.text` shape (Task 8).
    private var textSizeControl: UISegmentedControl!

    // Color palette offered by the swatch popover — identical ARGB literals
    // to AnnotationConstants.penColors (web PEN_COLORS parity). Order is
    // intentional — red is the most-used annotation color so it stays the
    // default and first option.
    private static let palette: [(name: String, argb: UInt32)] = [
        ("Red",    AnnotationConstants.penColors[0]),
        ("Yellow", AnnotationConstants.penColors[1]),
        ("Cyan",   AnnotationConstants.penColors[2]),
        ("White",  AnnotationConstants.penColors[3]),
        ("Black",  AnnotationConstants.penColors[4]),
    ]
    private var clearButton: UIButton!
    private var undoButton: UIButton!
    private var redoButton: UIButton!
    private var doneButton: UIButton!

    // MARK: - Init

    public init(
        sourceImage: UIImage,
        annotations: [Annotation] = []
    ) {
        self.sourceImage = sourceImage
        super.init(nibName: nil, bundle: nil)
        self.modalPresentationStyle = .fullScreen
        // Seed the model with the host's prior commits so re-opening the
        // surface after a Done preserves the annotation set. History starts
        // fresh on each open — undo does not reach back across a re-open.
        self.annotations = annotations
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - viewDidLoad

    public override func viewDidLoad() {
        super.viewDidLoad()
        // Quiet-instrument fullscreen floor (web `.txx-annotate-overlay`:
        // `background: var(--txx-bg)`) — was a bespoke near-black literal
        // under the old bento-duo-blue palette; now routes through the
        // token like every other surface.
        view.backgroundColor = palette.bg

        let topBar = makeTopBar()
        view.addSubview(topBar)
        topBar.translatesAutoresizingMaskIntoConstraints = false

        canvasContainer.translatesAutoresizingMaskIntoConstraints = false
        canvasContainer.backgroundColor = .clear
        view.addSubview(canvasContainer)

        // _imageView is frame-managed (not Auto Layout) so its frame can be
        // set to exactly `transform.imageFrameInView` on every layout pass —
        // the ONE view↔image mapping must agree exactly between the image
        // and the overlay that draws on top of it. See viewDidLayoutSubviews.
        _imageView.image = sourceImage
        _imageView.contentMode = .scaleToFill
        canvasContainer.addSubview(_imageView)

        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.backgroundColor = .clear
        overlay.isUserInteractionEnabled = true
        overlay.host = self
        // AnnotationOverlayView is a private nested class with no ambient
        // access to self.palette (different type) — inject it the same way
        // `host` is injected, before any draw() call (setNeedsDisplay()
        // below is async; the earliest possible draw is a future run-loop
        // pass, well after this assignment).
        overlay.palette = palette
        canvasContainer.addSubview(overlay)

        // History cluster floats top-right of the canvas (NOT in the palette
        // pill) per CONTEXT § "History cluster".
        let history = makeHistoryCluster()
        history.translatesAutoresizingMaskIntoConstraints = false
        canvasContainer.addSubview(history)

        let palette = makePalettePill()
        palette.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(palette)

        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: safe.topAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 44),

            canvasContainer.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
            canvasContainer.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
            canvasContainer.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 12),
            canvasContainer.bottomAnchor.constraint(equalTo: palette.topAnchor, constant: -12),

            // Overlay pins to canvasContainer directly (NOT to imageView) —
            // overlay.bounds.size is the `viewSize` ImageTransform is built
            // from; imageView's frame is derived FROM the transform, not the
            // other way around.
            overlay.leadingAnchor.constraint(equalTo: canvasContainer.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: canvasContainer.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: canvasContainer.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: canvasContainer.bottomAnchor),

            history.topAnchor.constraint(equalTo: canvasContainer.topAnchor, constant: 12),
            history.trailingAnchor.constraint(equalTo: canvasContainer.trailingAnchor, constant: -12),

            // Required equal-pin (NOT inequality-only) — matches
            // canvasContainer's own 16pt leading/trailing pin above. The
            // pill previously had ONLY centerX + bottom, with no width-
            // bounding constraint at all: since the (pre-fix) stack pinned
            // directly to the pill's edges with required constraints, the
            // pill's ~700pt intrinsic content width propagated up
            // unbounded, and the centered pill hung equally off both
            // screen edges — explaining the device screenshot (only the
            // horizontal MIDDLE of the row survived on-screen; the
            // pointer/pen buttons at one end and thickness/trash/Clear at
            // the other were rendered past the display bounds, not merely
            // "crushed" by Auto Layout). A required leading/trailing pin
            // gives the pill (and therefore the scroll view inside it, see
            // makePalettePill) a definite, on-screen frame width, so the
            // new UIScrollView — not the layout engine's ambiguity
            // resolution — is what absorbs the overflow.
            palette.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 16),
            palette.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
            palette.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -12),
        ])

        refreshPaletteSelection()
        updateHistoryButtons()
        updateTrashButtonState()
        refreshStyleRow()
        overlay.setNeedsDisplay()

        observeKeyboardForTextEditing()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // overlay is a nested subview — on the first root-view pass its bounds
        // are still .zero (degenerate transform → _imageView at natural size,
        // "zoomed" until the next invalidation). Resolve the nested layout NOW
        // so the transform is built from real bounds in the same pass.
        canvasContainer.layoutIfNeeded()
        guard overlay.bounds.width > 0, overlay.bounds.height > 0 else { return }
        // Rebuild the ONE view↔image mapping from the overlay's just-laid-out
        // bounds, then size _imageView to match exactly — image and overlay
        // must agree on every pixel or the live-preview annotations drift
        // from the screenshot underneath them.
        transform = ImageTransform(imageSize: sourceImage.size, viewSize: overlay.bounds.size)
        _imageView.frame = transform.imageFrameInView
        overlay.setNeedsDisplay()
    }

    // MARK: - Top bar (CONTEXT § "Top bar: unchanged" — Cancel · Edit · Done)

    private func makeTopBar() -> UIView {
        let bar = UIView()
        // Quiet-instrument top bar surface — bg3 with a hairline bottom
        // edge (web `.txx-annotate-overlay-bar` sits on the bg3-tinted
        // chrome the palette pill also uses).
        bar.backgroundColor = palette.bg3
        // A subtle hairline divider on the bottom so the top bar reads as a
        // separate surface above the canvas.
        let divider = UIView()
        divider.translatesAutoresizingMaskIntoConstraints = false
        divider.backgroundColor = palette.hair
        bar.addSubview(divider)

        let cancel = UIButton(type: .system)
        var cancelCfg = UIButton.Configuration.plain()
        cancelCfg.attributedTitle = AttributedString(
            "Cancel",
            attributes: AttributeContainer([
                .font: UIFont.systemFont(ofSize: 15, weight: .regular),
                .foregroundColor: palette.ink2,
            ])
        )
        cancel.configuration = cancelCfg
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        // Quiet-instrument bar label — sentence-case sans 13pt medium ink2
        // (web comment: "sentence-case sans bar label (mono-uppercase
        // eyebrow retired with the admin restyle)" on
        // `.txx-annotate-overlay-bar-center`). Was mono-uppercase-tracked
        // under the old bento-duo-blue palette.
        let title = UILabel()
        title.attributedText = NSAttributedString(
            string: "Edit screenshot",
            attributes: [
                .foregroundColor: palette.ink2,
                .font: UIFont.systemFont(ofSize: 13, weight: .medium),
            ]
        )
        title.textAlignment = .center

        // Done — flat primary fill matching the other brand-accent buttons in
        // the reporter (no gradient). Solid BrandTokens.accent with dark
        // accentFg semibold label (web `.txx-annotate-done`: `color:
        // var(--txx-accent-fg)`).
        doneButton = UIButton(type: .system)
        doneButton.translatesAutoresizingMaskIntoConstraints = false
        var doneCfg = UIButton.Configuration.filled()
        doneCfg.baseBackgroundColor = palette.accent
        doneCfg.baseForegroundColor = palette.accentFg
        doneCfg.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 18, bottom: 8, trailing: 18)
        doneCfg.attributedTitle = AttributedString(
            "Done",
            attributes: AttributeContainer([
                .font: UIFont.systemFont(ofSize: 15, weight: .semibold),
                .foregroundColor: palette.accentFg,
            ])
        )
        doneCfg.background.cornerRadius = 8  // controls radius
        doneButton.configuration = doneCfg
        doneButton.addTarget(self, action: #selector(doneTapped), for: .touchUpInside)

        for v in [cancel, title, doneButton!] {
            v.translatesAutoresizingMaskIntoConstraints = false
            bar.addSubview(v)
        }
        NSLayoutConstraint.activate([
            cancel.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 16),
            cancel.centerYAnchor.constraint(equalTo: bar.centerYAnchor),

            title.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
            title.centerYAnchor.constraint(equalTo: bar.centerYAnchor),

            doneButton.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -16),
            doneButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            doneButton.heightAnchor.constraint(equalToConstant: 36),

            divider.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
            divider.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            divider.bottomAnchor.constraint(equalTo: bar.bottomAnchor),
            divider.heightAnchor.constraint(equalToConstant: 1.0 / max(UIScreen.main.scale, 1)),
        ])
        return bar
    }

    // MARK: - Bottom palette pill (CONTEXT § "Bottom palette pill")
    //
    // Order: Pointer, Pen, Highlighter, Rect, Ellipse, Arrow, Text, Redact,
    // separator, color swatch, separator, Clear. Phone variant is
    // icon-only 18pt SF Symbols; tablet variant is icon + label. We render
    // the phone layout for both today — the tablet labels are a CONTEXT
    // discretion and not gated by the plan's acceptance criteria.

    private func makePalettePill() -> UIView {
        let pill = UIView()
        // Quiet-instrument palette bar: calm rounded-rect on bg3 with a
        // hairline border — web comment on `.txx-annotation-toolbar`:
        // "Bg3 surface, hairline border, calm rounded-rect (the 22px pill
        // went with the bento look)." bg3 (not .systemBackground) so the
        // panel stays dark even in a light-mode host app.
        pill.layer.cornerRadius = 10  // cards radius
        pill.backgroundColor = palette.bg3.withAlphaComponent(0.94)
        pill.layer.borderWidth = 1
        pill.layer.borderColor = palette.hair.cgColor
        // Frosted-material backdrop so the pill reads as a floating surface
        // over the canvas (matches the mock's `backdrop-filter: blur(20px)`).
        let blurBg = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        blurBg.translatesAutoresizingMaskIntoConstraints = false
        blurBg.isUserInteractionEnabled = false
        blurBg.layer.cornerRadius = 10
        blurBg.layer.masksToBounds = true
        pill.insertSubview(blurBg, at: 0)

        pointerButton = makeToolButton(symbol: "cursorarrow", action: #selector(selectPointer))
        penButton = makeToolButton(symbol: "pencil.tip", action: #selector(selectPen))
        highlighterButton = makeToolButton(symbol: "highlighter", action: #selector(selectHighlighter))
        rectButton = makeToolButton(symbol: "rectangle", action: #selector(selectRect))
        ellipseButton = makeToolButton(symbol: "circle", action: #selector(selectEllipse))
        arrowButton = makeToolButton(symbol: "arrow.up.right", action: #selector(selectArrow))
        textButton = makeToolButton(symbol: "textformat", action: #selector(selectText))
        // "rectangle.fill.slash" is not a real SF Symbol name (confirmed
        // against CoreGlyphs' name_availability.plist — no such entry
        // exists at all, on any iOS version), so `UIImage(systemName:)`
        // always returned nil and every device fell through to the
        // `eye.slash` fallback (matches the device screenshot). Its
        // non-filled sibling "rectangle.slash" IS a real symbol — SF
        // Symbols 2 / iOS 14 — one full major version below this package's
        // iOS 15 floor (Package.swift), so the existence check always
        // succeeds and this reads as "redact" (a slashed rectangle) instead
        // of "hide" (a slashed eye). Fallback chain kept for defense in
        // depth (e.g. a future symbol rename).
        redactButton = makeToolButton(
            symbol: UIImage(systemName: "rectangle.slash") != nil ? "rectangle.slash" : "eye.slash",
            action: #selector(selectRedact)
        )
        let sep1 = makePillSeparator()
        let sep2 = makePillSeparator()

        // Color swatch — tap opens a native UIMenu with the brand palette.
        // 26pt circle filled with the current stroke color, double-ringed
        // (outer 2pt accent border, inner 13pt corner radius).
        swatchButton = UIButton(type: .custom)
        swatchButton.translatesAutoresizingMaskIntoConstraints = false
        swatchButton.layer.cornerRadius = 16
        swatchButton.layer.borderWidth = 2
        swatchButton.layer.borderColor = palette.accent.cgColor
        swatchButton.showsMenuAsPrimaryAction = true
        swatchButton.menu = makeColorPickerMenu()
        swatchView = UIView()
        swatchView.translatesAutoresizingMaskIntoConstraints = false
        swatchView.backgroundColor = UIColor(argb: currentColor)
        swatchView.layer.cornerRadius = 13
        swatchView.isUserInteractionEnabled = false
        swatchButton.addSubview(swatchView)
        NSLayoutConstraint.activate([
            swatchButton.widthAnchor.constraint(equalToConstant: 32),
            swatchButton.heightAnchor.constraint(equalToConstant: 32),
            swatchView.widthAnchor.constraint(equalToConstant: 26),
            swatchView.heightAnchor.constraint(equalToConstant: 26),
            swatchView.centerXAnchor.constraint(equalTo: swatchButton.centerXAnchor),
            swatchView.centerYAnchor.constraint(equalTo: swatchButton.centerYAnchor),
        ])

        // Thickness steps (web PEN_THICKNESSES parity) — restyles the
        // selection live (Step 2) or sets the default for new shapes.
        thicknessControl = UISegmentedControl(items: AnnotationConstants.penThicknesses.map { "\(Int($0))" })
        thicknessControl.translatesAutoresizingMaskIntoConstraints = false
        thicknessControl.selectedSegmentIndex = AnnotationConstants.penThicknesses.firstIndex(of: currentThickness) ?? 1
        thicknessControl.addTarget(self, action: #selector(thicknessChanged(_:)), for: .valueChanged)
        thicknessControl.widthAnchor.constraint(equalToConstant: 104).isActive = true

        // S/M/L text-size steps — mutually exclusive with thicknessControl
        // (refreshStyleRow toggles isHidden on both); labels are letters
        // (not the px literal) per web's `s === 16 ? 'S' : s === 24 ? 'M' : 'L'`.
        textSizeControl = UISegmentedControl(items: ["S", "M", "L"])
        textSizeControl.translatesAutoresizingMaskIntoConstraints = false
        textSizeControl.selectedSegmentIndex = AnnotationConstants.textFontSizes.firstIndex(of: currentFontSize) ?? 1
        textSizeControl.addTarget(self, action: #selector(textSizeChanged(_:)), for: .valueChanged)
        textSizeControl.widthAnchor.constraint(equalToConstant: 104).isActive = true

        // Trash — deletes the selected shape; disabled with nothing selected.
        trashButton = makeToolButton(symbol: "trash", action: #selector(deleteSelectedTapped))

        clearButton = UIButton(type: .system)
        var clearCfg = UIButton.Configuration.plain()
        clearCfg.attributedTitle = AttributedString(
            "Clear",
            attributes: AttributeContainer([
                .font: UIFont.systemFont(ofSize: 13, weight: .medium),
                .foregroundColor: palette.hot,
            ])
        )
        clearCfg.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10)
        clearButton.configuration = clearCfg
        clearButton.addTarget(self, action: #selector(clearTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            pointerButton, penButton, highlighterButton, rectButton, ellipseButton,
            arrowButton, textButton, redactButton,
            sep1, swatchButton, thicknessControl, textSizeControl, sep2, trashButton, clearButton,
        ])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.distribution = .fill
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false

        // The pill's content (9 tool buttons + 2 separators + swatch +
        // segmented control + trash + Clear, ~700pt at 10pt spacing) does
        // not fit a phone-width safe area. A plain UIStackView hard-pinned
        // to the pill's edges gets crushed/clipped by UIKit on-device
        // (confirmed via device screenshot — only ~6 of 16 arranged views
        // remained visible/tappable). Mirror Android's BottomPalette fix
        // (`Modifier.horizontalScroll(rememberScrollState())`): wrap the
        // stack in a horizontal UIScrollView so overflow scrolls instead of
        // clipping.
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.alwaysBounceVertical = false
        scroll.alwaysBounceHorizontal = true
        scroll.clipsToBounds = true  // respect the pill's rounded corners
        scroll.addSubview(stack)
        pill.addSubview(scroll)

        // Low-priority equal-width tie: on iPad (content fits) this holds
        // and the stack fills the scroll view's width with no scrolling —
        // on iPhone (content overflows) it's the constraint that yields, so
        // the stack instead sizes to its intrinsic (fitting) width inside
        // contentLayoutGuide and the scroll view scrolls. NOT `>=` — a
        // greater-than-or-equal width doesn't force centering/no-scroll on
        // iPad, it just under-constrains the stack's width entirely.
        let widthTie = stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)
        widthTie.priority = .defaultLow

        NSLayoutConstraint.activate([
            blurBg.leadingAnchor.constraint(equalTo: pill.leadingAnchor),
            blurBg.trailingAnchor.constraint(equalTo: pill.trailingAnchor),
            blurBg.topAnchor.constraint(equalTo: pill.topAnchor),
            blurBg.bottomAnchor.constraint(equalTo: pill.bottomAnchor),

            scroll.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 12),
            scroll.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: pill.topAnchor, constant: 10),
            scroll.bottomAnchor.constraint(equalTo: pill.bottomAnchor, constant: -10),

            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            widthTie,
        ])
        return pill
    }

    private func makeToolButton(symbol: String, action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        var cfg = UIButton.Configuration.plain()
        cfg.image = UIImage(systemName: symbol)?.withConfiguration(
            UIImage.SymbolConfiguration(pointSize: 18, weight: .medium)
        )
        cfg.baseForegroundColor = palette.accent
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12)
        cfg.background.cornerRadius = 8  // controls radius
        b.configuration = cfg
        b.translatesAutoresizingMaskIntoConstraints = false
        b.addTarget(self, action: action, for: .touchUpInside)
        b.heightAnchor.constraint(equalToConstant: 36).isActive = true
        return b
    }

    private func makePillSeparator() -> UIView {
        let v = UIView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.backgroundColor = palette.ink3.withAlphaComponent(0.3)
        NSLayoutConstraint.activate([
            v.widthAnchor.constraint(equalToConstant: 1),
            v.heightAnchor.constraint(equalToConstant: 22),
        ])
        return v
    }

    // MARK: - Style row (color + thickness) — Task 6 Step 2
    //
    // "Effective" style = the SELECTED shape's value when there is a
    // selection, else the default that future shapes will use. This mirrors
    // the web style row, whose swatch/thickness highlighting tracks
    // `selectedShape` when present (AnnotateCanvas.tsx `editProps`/style row).

    private var effectiveColor: UInt32 {
        if let selId = selectedId, let shape = annotations.first(where: { $0.id == selId }) {
            return shape.color
        }
        return currentColor
    }

    private var effectiveThickness: CGFloat {
        if let selId = selectedId, let shape = annotations.first(where: { $0.id == selId }) {
            return shape.thickness
        }
        return currentThickness
    }

    /// The selected `.text` shape's fontSize, else the default for the next
    /// new text shape.
    private var effectiveFontSize: CGFloat {
        if let selId = selectedId, let shape = annotations.first(where: { $0.id == selId }), shape.kind == .text {
            return shape.fontSize
        }
        return currentFontSize
    }

    /// True when the S/M/L text-size row should show INSTEAD of the
    /// thickness row (web: `tool === 'text' || selectedShape?.kind === 'text'`).
    private var showsTextSizeRow: Bool {
        if activeTool == .text { return true }
        if let selId = selectedId, let shape = annotations.first(where: { $0.id == selId }) {
            return shape.kind == .text
        }
        return false
    }

    private func makeColorPickerMenu() -> UIMenu {
        let current = effectiveColor
        let actions = Self.palette.map { entry -> UIAction in
            UIAction(
                title: entry.name,
                image: Self.swatchImage(argb: entry.argb),
                state: entry.argb == current ? .on : .off
            ) { [weak self] _ in
                self?.applyStrokeColor(entry.argb)
            }
        }
        return UIMenu(title: "Stroke color", children: actions)
    }

    /// Restyles the selected shape live when one exists (one history push per
    /// action); otherwise sets the default color for future pen/highlighter/
    /// rect/ellipse/arrow shapes (today's behavior, unchanged). ALSO pushes
    /// into the live `textEditor` (Task 8) when a text-editing session is
    /// active — while it's up, `draw(rect)` skips rendering the underlying
    /// (stale) committed shape, so the UITextView is the ONLY visible copy;
    /// without this the swatch tap would look like a no-op until commit
    /// (web parity — AnnotateCanvas.tsx's textarea binds `style.color` to
    /// the live model entry, which the S/M/L handler patches even for a
    /// same-render fresh placement).
    private func applyStrokeColor(_ argb: UInt32) {
        if let selId = selectedId, let idx = annotations.firstIndex(where: { $0.id == selId }) {
            history.push(snapshot: annotations)
            annotations[idx].color = argb
        } else {
            currentColor = argb
        }
        textEditor?.textColor = UIColor(argb: argb)
        refreshStyleRow()
    }

    /// Restyles the selected shape's thickness live when one exists;
    /// otherwise sets the default for future shapes. Same push-once contract
    /// as `applyStrokeColor`.
    private func applyThickness(_ thickness: CGFloat) {
        if let selId = selectedId, let idx = annotations.firstIndex(where: { $0.id == selId }) {
            history.push(snapshot: annotations)
            annotations[idx].thickness = thickness
        } else {
            currentThickness = thickness
        }
        refreshStyleRow()
    }

    /// Restyles the selected `.text` shape's fontSize live (one history push,
    /// then re-stamps width/height from re-measured text so hit-testing/
    /// handles stay in sync with the new rendered size — same contract as
    /// `restampTextBox`); otherwise sets the default for the next new text.
    /// ALSO pushes into the live `textEditor` (same rationale as
    /// `applyStrokeColor`) and re-autosizes it, since a font-size change
    /// reflows the box.
    private func applyFontSize(_ size: CGFloat) {
        if let selId = selectedId, let idx = annotations.firstIndex(where: { $0.id == selId }), annotations[idx].kind == .text {
            history.push(snapshot: annotations)
            annotations[idx].fontSize = size
            annotations[idx] = restampTextBox(annotations[idx])
        } else {
            currentFontSize = size
        }
        if let editor = textEditor {
            editor.font = .systemFont(ofSize: size * transform.scale)
            autosizeTextEditorFrame(editor)
            applyKeyboardShiftIfNeeded()
        }
        refreshStyleRow()
    }

    /// Refreshes the swatch chip, color-menu checkmark, and thickness/
    /// text-size control to reflect `effectiveColor`/`effectiveThickness`/
    /// `effectiveFontSize` — called after a restyle action and whenever the
    /// selection or active tool changes.
    private func refreshStyleRow() {
        guard swatchView != nil, swatchButton != nil, thicknessControl != nil, textSizeControl != nil else { return }
        swatchView.backgroundColor = UIColor(argb: effectiveColor)
        swatchButton.menu = makeColorPickerMenu()
        if let idx = AnnotationConstants.penThicknesses.firstIndex(of: effectiveThickness) {
            thicknessControl.selectedSegmentIndex = idx
        } else {
            thicknessControl.selectedSegmentIndex = UISegmentedControl.noSegment
        }
        if let idx = AnnotationConstants.textFontSizes.firstIndex(of: effectiveFontSize) {
            textSizeControl.selectedSegmentIndex = idx
        } else {
            textSizeControl.selectedSegmentIndex = UISegmentedControl.noSegment
        }
        let showText = showsTextSizeRow
        thicknessControl.isHidden = showText
        textSizeControl.isHidden = !showText
    }

    /// Small filled-circle SF Symbol tinted with the palette color. Used as
    /// the leading icon in each UIAction.
    private static func swatchImage(argb: UInt32) -> UIImage? {
        let cfg = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
        return UIImage(systemName: "circle.fill", withConfiguration: cfg)?
            .withTintColor(UIColor(argb: argb), renderingMode: .alwaysOriginal)
    }

    // MARK: - History cluster (Undo / Redo)

    private func makeHistoryCluster() -> UIView {
        let host = UIView()

        undoButton = makeHistoryButton(symbol: "arrow.uturn.backward", action: #selector(undoTapped))
        redoButton = makeHistoryButton(symbol: "arrow.uturn.forward", action: #selector(redoTapped))

        let stack = UIStackView(arrangedSubviews: [undoButton, redoButton])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            stack.topAnchor.constraint(equalTo: host.topAnchor),
            stack.bottomAnchor.constraint(equalTo: host.bottomAnchor),
        ])
        return host
    }

    private func makeHistoryButton(symbol: String, action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        var cfg = UIButton.Configuration.plain()
        cfg.image = UIImage(systemName: symbol)?.withConfiguration(
            UIImage.SymbolConfiguration(pointSize: 14, weight: .medium)
        )
        cfg.baseForegroundColor = palette.accent
        // bg3 (not .systemBackground) — stays dark regardless of host
        // appearance, matching the palette pill's frosted bg3 surface.
        cfg.background.backgroundColor = palette.bg3.withAlphaComponent(0.8)
        cfg.background.cornerRadius = 8  // controls radius
        cfg.background.strokeColor = palette.hair
        cfg.background.strokeWidth = 1
        cfg.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6)
        b.configuration = cfg
        b.translatesAutoresizingMaskIntoConstraints = false
        b.addTarget(self, action: action, for: .touchUpInside)
        NSLayoutConstraint.activate([
            b.widthAnchor.constraint(equalToConstant: 36),
            b.heightAnchor.constraint(equalToConstant: 36),
        ])
        return b
    }

    // MARK: - Selection / enabled state

    private func refreshPaletteSelection() {
        applyToolButtonState(pointerButton,     isActive: activeTool == .pointer)
        applyToolButtonState(penButton,         isActive: activeTool == .pen)
        applyToolButtonState(highlighterButton, isActive: activeTool == .highlighter)
        applyToolButtonState(rectButton,        isActive: activeTool == .rect)
        applyToolButtonState(ellipseButton,     isActive: activeTool == .ellipse)
        applyToolButtonState(arrowButton,       isActive: activeTool == .arrow)
        applyToolButtonState(textButton,        isActive: activeTool == .text)
        applyToolButtonState(redactButton,      isActive: activeTool == .redact)
    }

    private func applyToolButtonState(_ b: UIButton, isActive: Bool) {
        guard b != nil else { return }
        var cfg = b.configuration ?? UIButton.Configuration.plain()
        // Active tool: solid amber chip with dark glyph (web
        // `.txx-tool-btn-active`: `background: var(--txx-accent); color:
        // var(--txx-accent-fg);`) — was a near-white glyph on cyan.
        cfg.baseForegroundColor = isActive
            ? palette.accentFg
            : palette.accent
        cfg.background.backgroundColor = isActive
            ? palette.accent
            : .clear
        cfg.background.cornerRadius = 8  // controls radius
        b.configuration = cfg
    }

    private func updateHistoryButtons() {
        guard undoButton != nil, redoButton != nil else { return }
        undoButton.isEnabled = history.canUndo
        redoButton.isEnabled = history.canRedo
        undoButton.tintColor = history.canUndo
            ? palette.accent
            : palette.ink3.withAlphaComponent(0.5)
        redoButton.tintColor = history.canRedo
            ? palette.accent
            : palette.ink3.withAlphaComponent(0.5)
    }

    /// Trash is enabled iff a shape is selected (Task 6 Step 2).
    private func updateTrashButtonState() {
        guard trashButton != nil else { return }
        let enabled = selectedId != nil
        trashButton.isEnabled = enabled
        var cfg = trashButton.configuration ?? UIButton.Configuration.plain()
        cfg.baseForegroundColor = enabled ? palette.accent : palette.ink3.withAlphaComponent(0.4)
        trashButton.configuration = cfg
    }

    // MARK: - Tool actions

    @objc private func selectPointer()     { activeTool = .pointer }
    @objc private func selectPen()         { activeTool = .pen }
    @objc private func selectHighlighter() { activeTool = .highlighter }
    @objc private func selectRect()        { activeTool = .rect }
    @objc private func selectEllipse()     { activeTool = .ellipse }
    @objc private func selectArrow()       { activeTool = .arrow }
    @objc private func selectText()        { activeTool = .text }
    @objc private func selectRedact()      { activeTool = .redact }

    @objc private func clearTapped() {
        // Deterministic-commit call site (Fix round 1, Finding 1): an
        // in-flight text edit must land in `annotations` (and its own
        // history entry) BEFORE Clear pushes its own snapshot and empties
        // the array — otherwise the live UITextView keeps typing over a
        // shape that Clear already discarded, and the eventual (now
        // no-op'd) commit silently drops the user's edit. See the doc
        // comment on `commitTextEditingIfAny()` for the full call-site list
        // and the per-button interaction analysis in task-8-report.md
        // "Fix round 1".
        commitTextEditingIfAny()
        history.push(snapshot: annotations)
        annotations = []
        selectedId = nil
    }

    @objc private func undoTapped() {
        // Same rationale as `clearTapped` — commit first so a mid-edit Undo
        // undoes the user's own just-committed edit (recoverable via Redo)
        // rather than silently losing text a stale `.patch(id)` commit would
        // no-op against.
        commitTextEditingIfAny()
        if let prev = history.undo(current: annotations) { annotations = prev }
    }

    @objc private func redoTapped() {
        // Same rationale as `clearTapped`. Note: if the commit itself
        // pushes a history entry (`.appendNew`/`.patch`/`.delete`), that
        // push clears `history.future` (EditorHistory.push's documented
        // "invalidates redo" contract) — a pending redo becomes unreachable
        // once a mid-edit Redo tap commits a NEW edit on top of it. This
        // mirrors ordinary "new edit after undo clears redo" semantics
        // (e.g. drawing a fresh shape already does this via
        // `commitDrawing`'s `history.push`), so it is not a regression:
        // the commit itself is the new edit that invalidates the stale
        // future.
        commitTextEditingIfAny()
        if let next = history.redo(current: annotations) { annotations = next }
    }

    @objc private func deleteSelectedTapped() {
        // Same rationale as `clearTapped`. Ordering note: for a re-edit of
        // an EXISTING shape, `selectedId` already equals that shape's id
        // before the commit (Trash requires a selection, and entry into
        // `beginTextEditingExisting` only happens via a second tap on an
        // already-selected text shape) and the `.patch` branch never
        // reassigns `selectedId` — so this deletes the just-committed
        // (edited) shape, coherent with "commit first, then delete the
        // now-committed selection." For a brand-NEW placement,
        // `commitTextEditingIfAny`'s `.appendNew` branch DOES mutate
        // `selectedId` (sets it to the freshly-appended shape) — but a new
        // placement only starts after `gestureEnded`'s `.deselect` case has
        // already set `selectedId = nil`, so there is no OTHER shape's
        // selection to clobber; the commit's `selectedId` reassignment
        // simply makes "Trash right after typing a new annotation" delete
        // the annotation just typed, which is the intuitive outcome.
        commitTextEditingIfAny()
        guard selectedId != nil else { return }
        history.push(snapshot: annotations)
        annotations.removeAll { $0.id == selectedId }
        selectedId = nil
    }

    @objc private func thicknessChanged(_ sender: UISegmentedControl) {
        guard sender.selectedSegmentIndex >= 0,
              sender.selectedSegmentIndex < AnnotationConstants.penThicknesses.count else { return }
        applyThickness(AnnotationConstants.penThicknesses[sender.selectedSegmentIndex])
    }

    @objc private func textSizeChanged(_ sender: UISegmentedControl) {
        guard sender.selectedSegmentIndex >= 0,
              sender.selectedSegmentIndex < AnnotationConstants.textFontSizes.count else { return }
        applyFontSize(AnnotationConstants.textFontSizes[sender.selectedSegmentIndex])
    }

    // MARK: - Inline text editing (Task 8)
    //
    // Deterministic commit (spec table — TextCommitLogic.swift is the pure
    // decision, this executes it): EVERY path that can end a text-editing
    // session OR otherwise mutate `annotations`/`history` out from under a
    // live editor funnels through `commitTextEditingIfAny()` FIRST, and it
    // is the ONLY place that tears down `textEditor`/mutates `annotations`
    // for a text edit. The eight call sites (none of which can race — UIKit
    // delivers touches, button taps, and keyboard notifications serially on
    // the main actor):
    //   1. `gestureBegan` — before every new touch session (rule 1).
    //   2. `textView(_:shouldChangeTextIn:)` on Return (web: Enter commits,
    //      no newline insertion).
    //   3. `doneTapped` — before handing `annotations` to the host.
    //   4. `keyboardWillHide` — covers external dismissal (hardware keyboard
    //      Escape, app backgrounding) that doesn't route through 1-3.
    //   5. `undoTapped` — before popping the undo stack (Fix round 1,
    //      Finding 1).
    //   6. `redoTapped` — before popping the redo stack (Fix round 1,
    //      Finding 1; note the commit's own push can invalidate the very
    //      redo entry the tap wanted — see that method's doc comment).
    //   7. `clearTapped` — before emptying `annotations` (Fix round 1,
    //      Finding 1).
    //   8. `deleteSelectedTapped` — before removing the selected shape (Fix
    //      round 1, Finding 1).
    // Call sites 5-8 exist because `annotations`/`history` are mutated
    // directly by those four buttons; without committing first, the shape
    // backing a live `textEditor` can be swapped/deleted/history-reset
    // while the editor keeps typing into it, so the eventual (now stale)
    // `.patch(id)` commit silently no-ops and the user's edit is lost.
    // Re-entrancy: `commitTextEditingIfAny` nils `textEditor` BEFORE calling
    // `resignFirstResponder()`, so if that resignation synchronously posts
    // `keyboardWillHide` (already inside this same call, or later), the
    // nested/second call's guard sees `textEditor == nil` and no-ops instead
    // of double-committing.

    /// Commits any in-flight inline text editor before a new touch session
    /// begins (rule 1), on Done, on Return, and on keyboard dismissal.
    /// Executes the pure `textCommitAction` decision (TextCommitLogic.swift):
    /// new+non-empty appends, new+empty cancels silently (no history entry),
    /// existing+non-empty patches, existing+now-empty deletes. Width/height
    /// are always re-stamped from `restampTextBox` (NSString measurement —
    /// the SAME measurement the draw path uses) rather than the UITextView's
    /// live bounds, so hit-testing/handles agree exactly with what renders.
    private func commitTextEditingIfAny() {
        guard let editor = textEditor else { return }
        let existingId = editingAnnotationId
        let origin = textEditOrigin
        // Clear session state FIRST (see re-entrancy note above) — everything
        // below reads from local captures, not the ivars.
        textEditor = nil
        editingAnnotationId = nil
        textEditOrigin = nil

        let raw = editor.text ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)

        switch textCommitAction(existingId: existingId, trimmedText: raw) {
        case .cancel:
            break // no history entry — a never-committed placement isn't an edit.

        case .appendNew:
            if let origin {
                history.push(snapshot: annotations)
                let shape = restampTextBox(
                    .text(x: origin.x, y: origin.y, text: trimmed, color: currentColor, fontSize: currentFontSize)
                )
                annotations.append(shape)
                selectedId = shape.id
            }

        case .patch(let id):
            history.push(snapshot: annotations)
            if let idx = annotations.firstIndex(where: { $0.id == id }) {
                annotations[idx].text = trimmed
                annotations[idx] = restampTextBox(annotations[idx])
            }

        case .delete(let id):
            history.push(snapshot: annotations)
            annotations.removeAll { $0.id == id }
            if selectedId == id { selectedId = nil }
        }

        editor.resignFirstResponder()
        editor.removeFromSuperview()
        overlay.setNeedsDisplay()
    }

    /// Re-measures a `.text` shape's actual rendered extent (NSString sizing
    /// — the SAME API the draw path uses via `.size(withAttributes:)`, a
    /// companion to `NSString.draw(at:withAttributes:)`) and stamps
    /// width/height from it. Called after every mutation that can change a
    /// text shape's rendered size (new commit, edit commit, live fontSize
    /// restyle, and post-resize-handle-drag) so hit-testing/handles
    /// (AnnotationModel's `normalizedBox`/`handles(for:)`, which read
    /// `width`/`height` for `.text` like every other box kind) never drift
    /// from what actually renders — `applyResize`'s own width/height (linear
    /// from the drag position) is only a first approximation for `.text`.
    private func restampTextBox(_ a: Annotation) -> Annotation {
        guard a.kind == .text else { return a }
        var out = a
        let size = Self.measureTextSize(a.text, fontSize: a.fontSize)
        out.width = size.width
        out.height = size.height
        return out
    }

    /// Image-pixel-space measurement — mirrors `BakeRenderer.draw`'s `.text`
    /// case (and the overlay's) attribute set exactly (font size is NOT
    /// multiplied by `transform.scale` here — this is image-px, not view-px).
    /// An empty string measures as a single space so a freshly-placed,
    /// not-yet-typed-into text still gets a non-zero hit box while its
    /// editor is up (draw(rect) skips it anyway — see the overlay's `draw`).
    private static func measureTextSize(_ text: String, fontSize: CGFloat) -> CGSize {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = AnnotationConstants.textLineHeight
        let attrs: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: fontSize),
            .paragraphStyle: paragraph,
        ]
        let measured = text.isEmpty ? " " : text
        return (measured as NSString).size(withAttributes: attrs)
    }

    /// Begins a NEW text-editing session at `imagePoint` (the `.text` tool's
    /// tap-on-empty-canvas placement — `// TASK-8-TEXT`). Nothing is added to
    /// `annotations` yet; `commitTextEditingIfAny()` does that (or discards
    /// it) when the session ends.
    private func beginTextEditingNew(at imagePoint: CGPoint) {
        editingAnnotationId = nil
        textEditOrigin = imagePoint
        let editor = makeTextEditor(text: "", fontSize: currentFontSize, color: currentColor, origin: imagePoint)
        textEditor = editor
        canvasContainer.addSubview(editor)
        editor.becomeFirstResponder()
        overlay.setNeedsDisplay()
        // Fix round 1, Finding 2: `becomeFirstResponder()` only triggers a
        // fresh `keyboardWillChangeFrame` notification when the keyboard's
        // FRAME actually changes. If a session begins while the keyboard is
        // already up (e.g. re-editing text right after committing a prior
        // edit, so the keyboard never goes down between sessions), no new
        // notification fires and this editor's shift would never get
        // computed against its own frame — it can render behind the
        // keyboard until the first keystroke calls `applyKeyboardShiftIfNeeded`
        // via `textViewDidChange`. Recompute unconditionally here from the
        // last-known keyboard frame (cached by `applyKeyboardShift`); a
        // no-op when the keyboard isn't up yet (guarded by
        // `lastKeyboardChangeNotification == nil`), and superseded by the
        // real notification's own call when the keyboard IS newly appearing.
        applyKeyboardShiftIfNeeded()
    }

    /// Begins re-editing an EXISTING `.text` shape — triggered by a second
    /// pending-tap on an already-selected text shape (see `gestureEnded`).
    /// The shape stays in `annotations` (and hidden from `draw(rect)` via
    /// `editingAnnotationId`) until commit. NOT `private` — same rationale
    /// as `textEditor` above: TextEditCommitGuardTests (Fix round 1) calls
    /// this directly to stand up a real in-flight edit session without a
    /// synthetic UITouch/gesture harness.
    func beginTextEditingExisting(_ id: AnnotationId) {
        guard let shape = annotations.first(where: { $0.id == id }), shape.kind == .text else { return }
        let origin = CGPoint(x: shape.x, y: shape.y)
        editingAnnotationId = id
        textEditOrigin = origin
        let editor = makeTextEditor(text: shape.text, fontSize: shape.fontSize, color: shape.color, origin: origin)
        textEditor = editor
        canvasContainer.addSubview(editor)
        editor.becomeFirstResponder()
        overlay.setNeedsDisplay()
        // Fix round 1, Finding 2 — see `beginTextEditingNew`'s matching call
        // for the full rationale (keyboard already up → no fresh
        // notification → shift never recomputed for THIS editor's frame).
        applyKeyboardShiftIfNeeded()
    }

    /// Builds the borderless, auto-growing UITextView overlay. `origin` is
    /// the IMAGE-pixel top-left anchor; the view's frame origin is derived
    /// from it via `transform` ONCE and never moves — only its size grows
    /// (`autosizeTextEditorFrame`) as the user types, matching the
    /// top-left-anchored box model every other kind uses.
    private func makeTextEditor(text: String, fontSize: CGFloat, color: UInt32, origin: CGPoint) -> UITextView {
        let tv = UITextView()
        tv.text = text
        tv.font = .systemFont(ofSize: fontSize * transform.scale)
        tv.textColor = UIColor(argb: color)
        tv.backgroundColor = .clear
        tv.tintColor = palette.accent
        tv.isScrollEnabled = false
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.returnKeyType = .done
        tv.autocorrectionType = .default
        tv.delegate = self
        let viewOrigin = transform.toView(origin)
        tv.frame = CGRect(origin: viewOrigin, size: CGSize(width: 40, height: fontSize * transform.scale * AnnotationConstants.textLineHeight))
        autosizeTextEditorFrame(tv)
        return tv
    }

    /// Grows `tv`'s frame to fit its CURRENT text (web `autosizeTextarea`
    /// parity — reset-then-remeasure so the box can also SHRINK as text is
    /// deleted). Unconstrained width (a very large `sizeThatFits` hint) so
    /// text only wraps at explicit newlines, matching `NSString.draw(at:)`'s
    /// unconstrained-width rendering in the draw path — this is a LIVE,
    /// UIKit-metrics preview only; the authoritative width/height stamped
    /// into the model comes from `restampTextBox`'s NSString measurement.
    private func autosizeTextEditorFrame(_ tv: UITextView) {
        let fitting = tv.sizeThatFits(CGSize(width: 2000, height: CGFloat.greatestFiniteMagnitude))
        var frame = tv.frame
        frame.size.width = max(40, fitting.width)
        frame.size.height = max(fitting.height, tv.font?.lineHeight ?? 20)
        tv.frame = frame
    }

    // MARK: - Gesture dispatch (called from AnnotationOverlayView)
    //
    // Every incoming point is view-space (overlay-local); converted to
    // image-pixel space via `transform.toImage(...)` before touching the
    // model. The touch session (`TouchSession`, declared with the model
    // state above) arbitrates between tap-select, move, resize, and draw —
    // see the 6 numbered rules in `.superpowers/sdd/task-6-brief.md`, quoted
    // inline at each decision point below. Text authoring (Task 8) never
    // draws through `inProgressAnnotation` — it opens an inline UITextView
    // overlay instead (`beginTextEditingNew`/`beginTextEditingExisting`,
    // `// TASK-8-TEXT` in `gestureEnded`), and the shape only enters
    // `annotations` when `commitTextEditingIfAny()` runs.

    /// Rule 1: began. Commit any in-flight text editor first, then hit-test
    /// in VIEW space against the selected shape's handles (≥44pt hit
    /// circles), then in IMAGE space against every shape's interior. Stores
    /// `.pending` — the gesture is undecided until it either lifts (tap) or
    /// exceeds `slopPt` (rule 2).
    fileprivate func gestureBegan(at p: CGPoint) {
        commitTextEditingIfAny()
        let img = transform.toImage(p)

        var onHandle: HandleKind?
        if let selId = selectedId, let selectedShape = annotations.first(where: { $0.id == selId }) {
            for h in handles(for: selectedShape) {
                let handleView = transform.toView(h.position)
                if hypot(p.x - handleView.x, p.y - handleView.y) <= 22 {
                    onHandle = h.kind
                    break
                }
            }
        }
        let onShape = hitTest(annotations, at: img, tolerance: 8 / transform.scale)

        session = .pending(startView: p, startImage: img, onHandle: onHandle, onShape: onShape)
    }

    /// Rules 2 and 3. While `.pending`, resolves the gesture into exactly one
    /// of `.resizing` / `.moving` / `.drawing`, or leaves it `.pending`, once
    /// view-space distance from the touch-down point exceeds `slopPt`. The
    /// decision itself is the pure `resolveDrag` (Annotation/
    /// SessionArbitration.swift) — this just executes it. Once resolved (or already
    /// resolved from a prior move event), applies the live mutation for
    /// `.moving`/`.resizing` (pushing history exactly once per gesture via
    /// each case's `pushed` flag) or forwards to the existing draw-update
    /// path for `.drawing`.
    fileprivate func gestureMoved(to p: CGPoint) {
        let img = transform.toImage(p)
        switch session {
        case .idle:
            return

        case .pending(let startView, let startImage, let onHandle, let onShape):
            let dist = hypot(p.x - startView.x, p.y - startView.y)
            guard dist > slopPt else { return }

            switch resolveDrag(activeTool: activeTool, onHandle: onHandle, onShape: onShape, selectedId: selectedId) {
            case .resize(let handle):
                // resolveDrag only returns .resize when selectedId != nil.
                guard let selId = selectedId else { return }
                session = .resizing(id: selId, handle: handle, pushed: false)
            case .move(let shape):
                if activeTool == .pointer, shape != selectedId {
                    selectedId = shape
                }
                session = .moving(id: shape, lastImage: startImage, pushed: false)
            case .draw:
                beginDrawing(at: startImage)
                session = .drawing
            case .ignore:
                // Pointer tool dragging over empty canvas — stay pending;
                // nothing to apply.
                return
            }
            // Re-dispatch this same move event now that the session has
            // resolved, so the very first move past slop also applies the
            // first mutation/draw sample rather than waiting for the next one.
            gestureMoved(to: p)

        case .drawing:
            updateDrawing(to: img)

        case .moving(let id, let lastImage, let pushed):
            guard let idx = annotations.firstIndex(where: { $0.id == id }) else {
                session = .idle
                return
            }
            if !pushed {
                history.push(snapshot: annotations)
            }
            let dx = img.x - lastImage.x
            let dy = img.y - lastImage.y
            annotations[idx] = translateAnnotation(annotations[idx], dx: dx, dy: dy)
            session = .moving(id: id, lastImage: img, pushed: true)

        case .resizing(let id, let handle, let pushed):
            guard let idx = annotations.firstIndex(where: { $0.id == id }) else {
                session = .idle
                return
            }
            if !pushed {
                history.push(snapshot: annotations)
            }
            annotations[idx] = applyResize(annotations[idx], handle: handle, to: img)
            session = .resizing(id: id, handle: handle, pushed: true)
        }
    }

    /// Rules 4 and 5. A gesture that never left `.pending` is a tap: any tool
    /// selects the tapped shape, or clears selection on an empty tap. The decision is the
    /// pure `resolveTap` (Annotation/SessionArbitration.swift); this executes
    /// it, plus two Task-8 text hooks layered on top of `.select`/`.deselect`
    /// (both still deterministic — exactly one outcome per tap, no tool
    /// re-entrancy since `gestureBegan` already committed any prior editor):
    ///   `.select(shape)` where `shape == selectedId` already AND it's a
    ///   `.text` shape → this is a SECOND pending-tap on an already-selected
    ///   text shape (simplest deterministic "double-tap to edit" trigger) —
    ///   open the inline editor instead of a no-op re-select.
    ///   `.deselect` with `activeTool == .text` → place a NEW text at the
    ///   tap point (`// TASK-8-TEXT`).
    /// A `.drawing` session commits per Task 5's threshold rules. `.moving`
    /// needs no further action. `.resizing` re-stamps a `.text` shape's
    /// width/height from its actual rendered extent once the drag ends
    /// (`applyResize`'s width/height is only a live-preview approximation
    /// for `.text` — see `restampTextBox`'s doc comment).
    fileprivate func gestureEnded(at p: CGPoint) {
        switch session {
        case .idle:
            break

        case .pending(_, let startImage, _, let onShape):
            switch resolveTap(activeTool: activeTool, onShape: onShape) {
            case .select(let shape):
                if shape == selectedId,
                   let existing = annotations.first(where: { $0.id == shape }),
                   existing.kind == .text {
                    beginTextEditingExisting(shape)
                } else {
                    selectedId = shape
                }
            case .deselect:
                selectedId = nil
                if activeTool == .text {
                    beginTextEditingNew(at: startImage)
                }
            }

        case .drawing:
            commitDrawing()

        case .moving:
            break

        case .resizing(let id, _, _):
            if let idx = annotations.firstIndex(where: { $0.id == id }), annotations[idx].kind == .text {
                annotations[idx] = restampTextBox(annotations[idx])
            }
        }
        session = .idle
    }

    /// Rule 6: cancelled. Reset to `.idle` and discard any in-flight drawing.
    fileprivate func gestureCancelled() {
        inProgressAnnotation = nil
        dragOrigin = nil
        session = .idle
        overlay.setNeedsDisplay()
    }

    // MARK: - Drawing (Task 5 behavior, unchanged — now entered via the
    // touch session's `.drawing` case instead of directly from
    // `gestureBegan`/`gestureMoved`/`gestureEnded`).

    /// Starts `inProgressAnnotation` for the active drawing tool at the
    /// given IMAGE point. `img` is the gesture's ORIGINAL touch-down point
    /// (rule 2: "start inProgressAnnotation at startImage"), not the point
    /// at which slop was exceeded.
    private func beginDrawing(at img: CGPoint) {
        switch activeTool {
        case .pen:
            inProgressAnnotation = .pen(points: [img.x, img.y], color: currentColor, thickness: currentThickness)
        case .highlighter:
            inProgressAnnotation = .highlighter(points: [img.x, img.y], color: currentColor, thickness: currentThickness)
        case .rect:
            dragOrigin = img
            inProgressAnnotation = .rect(x: img.x, y: img.y, width: 0, height: 0, color: currentColor, thickness: currentThickness)
        case .ellipse:
            dragOrigin = img
            inProgressAnnotation = .ellipse(x: img.x, y: img.y, width: 0, height: 0, color: currentColor, thickness: currentThickness)
        case .redact:
            dragOrigin = img
            inProgressAnnotation = .blur(x: img.x, y: img.y, width: 0, height: 0)
        case .arrow:
            inProgressAnnotation = .arrow(from: img, to: img, color: currentColor, thickness: currentThickness)
        case .pointer, .text:
            inProgressAnnotation = nil
        }
        overlay.setNeedsDisplay()
    }

    private func updateDrawing(to img: CGPoint) {
        guard var inProgress = inProgressAnnotation else { return }
        switch inProgress.kind {
        case .pen, .highlighter:
            inProgress.points.append(contentsOf: [img.x, img.y])
        case .rect, .ellipse, .blur:
            guard let origin = dragOrigin else { return }
            inProgress.x = min(origin.x, img.x)
            inProgress.y = min(origin.y, img.y)
            inProgress.width = abs(img.x - origin.x)
            inProgress.height = abs(img.y - origin.y)
        case .arrow:
            inProgress.to = img
        case .text:
            break
        }
        inProgressAnnotation = inProgress
        overlay.setNeedsDisplay()
    }

    private func commitDrawing() {
        defer {
            dragOrigin = nil
            overlay.setNeedsDisplay()
        }
        guard let inProgress = inProgressAnnotation else { return }
        // Commit gate: box kinds (rect/ellipse/blur/text) require BOTH
        // dimensions ≥ minDragCommit; strokes and arrows use diagonal extent.
        if meetsCommitThreshold(inProgress) {
            history.push(snapshot: annotations)
            annotations.append(inProgress)
            selectedId = inProgress.id
        }
        inProgressAnnotation = nil
    }

    // MARK: - Done / Cancel

    @objc private func doneTapped() {
        // Deterministic-commit call site 3 (Task 8) — a Done tap while the
        // inline text editor is up must commit it FIRST so the typed value
        // (or its delete/cancel) is in `annotations` before the array is
        // handed to the host; without this, unsaved in-flight text would be
        // silently dropped.
        commitTextEditingIfAny()
        // Host bakes at submit time (BakeRenderer.bake over `annotations`) —
        // this VC is a pure editing surface and never produces upload-bound
        // bytes itself (PRIV-03 stays a host-side responsibility).
        onDone?(annotations)
        dismiss(animated: true)
    }

    @objc private func cancelTapped() {
        onCancel?()
        dismiss(animated: true)
    }
}

// MARK: - Overlay view
//
// Owns the touch events and renders both committed annotations and the
// in-progress live preview, all model-driven. The overlay sits ON TOP of the
// imageView so touch events on the screenshot reach the gesture dispatcher;
// the imageView itself has userInteractionEnabled = false (UIImageView
// default).

@MainActor
private final class AnnotationOverlayView: UIView {

    weak var host: FocusedAnnotationViewController?
    /// Injected by `FocusedAnnotationViewController.viewDidLoad` alongside
    /// `host`, before any draw() call — this class is a separate type from
    /// the VC and has no ambient access to `self.palette` there, so its own
    /// `drawSelectionChrome(...)` needs a local copy rather than reaching
    /// through `host?.palette`.
    var palette: ResolvedPalette = .brand

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = false
        contentMode = .redraw
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let t = touches.first else { return }
        host?.gestureBegan(at: t.location(in: self))
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let t = touches.first else { return }
        host?.gestureMoved(to: t.location(in: self))
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let t = touches.first else { return }
        host?.gestureEnded(at: t.location(in: self))
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        host?.gestureCancelled()
    }

    override func draw(_ rect: CGRect) {
        guard let cg = UIGraphicsGetCurrentContext(), let host else { return }
        let t = host.transform
        // Task 8 item 3: while a `.text` shape's inline UITextView overlay is
        // up, skip rendering the underlying committed shape here — otherwise
        // the live-typed text (in the UITextView, sitting ON TOP) and the
        // stale committed text (drawn here, from BEFORE this edit's keystrokes)
        // would double-render.
        let editingId = host.editingAnnotationId
        for a in host.annotations where a.kind == .blur && a.id != editingId {
            // Preview redactions as solid black (what bake will produce —
            // PRIV-03 honesty: never show content the report would hide).
            cg.setFillColor(UIColor.black.cgColor)
            cg.fill(t.toView(normalizedBox(a)))
        }
        for a in host.annotations where a.kind != .blur && a.id != editingId {
            drawShape(a, transform: t, in: cg)
        }
        if let inProgress = host.inProgressAnnotation {
            if inProgress.kind == .blur {
                cg.setFillColor(UIColor.black.withAlphaComponent(0.6).cgColor)
                cg.fill(t.toView(normalizedBox(inProgress)))
            } else {
                drawShape(inProgress, transform: t, in: cg)
            }
        }
        if let sel = host.annotations.first(where: { $0.id == host.selectedId }), sel.id != editingId {
            drawSelectionChrome(for: sel, transform: t, in: cg)
        }
    }

    /// Mirrors `BakeRenderer.draw` exactly but multiplies every geometry
    /// value through `t` — points/rects via `t.toView`, line widths and font
    /// sizes via `* t.scale` — so the live preview matches the baked output
    /// pixel-for-pixel modulo the view/image scale factor.
    private func drawShape(_ a: Annotation, transform t: ImageTransform, in cg: CGContext) {
        let color = UIColor(argb: a.color)
        switch a.kind {
        case .pen, .highlighter:
            guard a.points.count >= 4 else { return }
            cg.saveGState()
            cg.setStrokeColor(color.cgColor)
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            if a.kind == .highlighter {
                cg.setAlpha(AnnotationConstants.highlighterOpacity)
                cg.setLineWidth(a.thickness * AnnotationConstants.highlighterWidthMultiplier * t.scale)
            } else {
                cg.setLineWidth(a.thickness * t.scale)
            }
            cg.move(to: t.toView(CGPoint(x: a.points[0], y: a.points[1])))
            var i = 2
            while i + 1 < a.points.count {
                cg.addLine(to: t.toView(CGPoint(x: a.points[i], y: a.points[i + 1])))
                i += 2
            }
            cg.strokePath()
            cg.restoreGState()
        case .rect:
            cg.setStrokeColor(color.cgColor)
            cg.setLineWidth(a.thickness * t.scale)
            cg.stroke(t.toView(normalizedBox(a)))
        case .ellipse:
            cg.setStrokeColor(color.cgColor)
            cg.setLineWidth(a.thickness * t.scale)
            cg.strokeEllipse(in: t.toView(normalizedBox(a)))
        case .arrow:
            let from = t.toView(a.from)
            let to = t.toView(a.to)
            cg.setStrokeColor(color.cgColor)
            cg.setFillColor(color.cgColor)
            cg.setLineWidth(a.thickness * t.scale)
            cg.setLineCap(.round)
            cg.move(to: from)
            cg.addLine(to: to)
            cg.strokePath()
            // Chevron head — same 12px @ 30° geometry BakeRenderer uses,
            // scaled through `t`.
            let angle = atan2(to.y - from.y, to.x - from.x)
            let headLen: CGFloat = max(12, a.thickness * 3) * t.scale
            for side in [CGFloat.pi / 6, -CGFloat.pi / 6] {
                cg.move(to: to)
                cg.addLine(to: CGPoint(
                    x: to.x - headLen * cos(angle + side),
                    y: to.y - headLen * sin(angle + side)))
            }
            cg.strokePath()
        case .text:
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineHeightMultiple = AnnotationConstants.textLineHeight
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: a.fontSize * t.scale),
                .foregroundColor: color,
                .paragraphStyle: paragraph,
            ]
            (a.text as NSString).draw(at: t.toView(CGPoint(x: a.x, y: a.y)), withAttributes: attrs)
        case .blur:
            break // handled by the dedicated blur-first loop in draw(_:) above
        }
    }

    /// Dashed accent rect around the selected shape (inflated 4pt) plus
    /// filled 8pt-diameter circles at each resize handle. Arrows skip the
    /// chrome rect — only their endpoint circles are drawn. Freehand strokes
    /// (pen/highlighter) have no handles (`handles(for:)` returns `[]`) —
    /// move-only, matching AnnotationModel's RESIZABLE_KINDS parity comment.
    private func drawSelectionChrome(for a: Annotation, transform t: ImageTransform, in cg: CGContext) {
        if a.kind != .arrow {
            let rect = t.toView(normalizedBox(a)).insetBy(dx: -4, dy: -4)
            cg.saveGState()
            cg.setStrokeColor(palette.accent.cgColor)
            cg.setLineWidth(1)
            cg.setLineDash(phase: 0, lengths: [4, 3])
            cg.stroke(rect)
            cg.restoreGState()
        }
        for h in handles(for: a) {
            let center = t.toView(h.position)
            let r: CGFloat = 4 // 8pt diameter
            cg.setFillColor(palette.accent.cgColor)
            cg.fillEllipse(in: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
        }
    }
}

// MARK: - UITextViewDelegate (Task 8 inline text editor)

extension FocusedAnnotationViewController: UITextViewDelegate {
    /// Return key commits instead of inserting a newline (web parity — Enter
    /// commits, Shift is not a thing on the soft keyboard here so there is no
    /// secondary "insert newline anyway" gesture to preserve).
    public func textView(
        _ textView: UITextView,
        shouldChangeTextIn range: NSRange,
        replacementText text: String
    ) -> Bool {
        guard text == "\n" else { return true }
        commitTextEditingIfAny()
        return false
    }

    /// Live auto-grow (web `autosizeTextarea` parity) as the user types —
    /// purely a UIKit-metrics preview; the authoritative width/height stamped
    /// into the model comes from `restampTextBox`'s NSString measurement at
    /// commit time, not from these live view bounds.
    public func textViewDidChange(_ textView: UITextView) {
        autosizeTextEditorFrame(textView)
        // The box may now overlap (or clear) the keyboard differently than
        // when it was placed — re-run the same overlap math keyboardWillChangeFrame
        // uses, without waiting for a keyboard frame notification (the
        // keyboard itself hasn't moved, only the editor's bottom edge has).
        applyKeyboardShiftIfNeeded()
    }
}

// MARK: - Keyboard insets (Task 8 Step 1.5 — spec risk #2)
//
// The inline editor can grow downward past the keyboard's top edge (a long
// multi-line text, or a placement near the bottom of the canvas). We
// translate `canvasContainer` up by exactly the overlap, animated alongside
// the keyboard's own show/hide curve, and restore it (also animated) on
// hide. `commitTextEditingIfAny()` also runs on hide so an external
// dismissal (hardware Escape, app backgrounding, the user swiping the
// keyboard away) still commits deterministically — call site 4 of the four
// listed on `commitTextEditingIfAny`'s doc comment.
extension FocusedAnnotationViewController {
    func observeKeyboardForTextEditing() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillChangeFrame(_:)),
            name: UIResponder.keyboardWillChangeFrameNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(keyboardWillHide(_:)),
            name: UIResponder.keyboardWillHideNotification, object: nil
        )
    }

    /// Shared show/move handler — recomputes and re-applies the shift any
    /// time the keyboard's frame changes (initial show, or a frame change
    /// e.g. predictive-text bar toggling), not just on first appearance.
    @objc private func keyboardWillChangeFrame(_ note: Notification) {
        applyKeyboardShift(from: note)
    }

    @objc private func keyboardWillHide(_ note: Notification) {
        // Call site 4 (see extension doc comment above) — MUST run even
        // though `applyKeyboardShift`'s own overlap math would already
        // compute 0 once the keyboard's endFrame is off-screen; committing
        // is the point of this handler, the shift-reset is secondary.
        commitTextEditingIfAny()
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let curveRaw = (note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int) ?? UIView.AnimationCurve.easeInOut.rawValue
        animateCanvasShift(to: .identity, duration: duration, curveRaw: curveRaw)
    }

    /// Re-derives the shift from the CURRENT keyboard frame without a fresh
    /// notification — used by `textViewDidChange` when the editor grows
    /// while the keyboard is already up.
    private func applyKeyboardShiftIfNeeded() {
        guard let note = lastKeyboardChangeNotification else { return }
        applyKeyboardShift(from: note)
    }

    private func applyKeyboardShift(from note: Notification) {
        lastKeyboardChangeNotification = note
        guard let editor = textEditor,
              let userInfo = note.userInfo,
              let endFrameValue = userInfo[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue else {
            return
        }
        let duration = (userInfo[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let curveRaw = (userInfo[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int) ?? UIView.AnimationCurve.easeInOut.rawValue
        let keyboardFrameInView = view.convert(endFrameValue.cgRectValue, from: nil)
        let editorFrameInView = canvasContainer.convert(editor.frame, to: view)
        // Undo any shift already applied before measuring the overlap, so
        // repeated calls (predictive bar toggling, text growing) measure
        // against the UNSHIFTED geometry each time rather than compounding.
        let unshiftedMaxY = editorFrameInView.maxY - canvasContainer.transform.ty
        let overlap = unshiftedMaxY - keyboardFrameInView.minY
        let shift = max(0, overlap + 8) // +8pt breathing room above the keyboard
        animateCanvasShift(
            to: shift > 0 ? CGAffineTransform(translationX: 0, y: -shift) : .identity,
            duration: duration,
            curveRaw: curveRaw
        )
    }

    private func animateCanvasShift(to transform: CGAffineTransform, duration: Double, curveRaw: Int) {
        let curve = UIView.AnimationCurve(rawValue: curveRaw) ?? .easeInOut
        let animator = UIViewPropertyAnimator(duration: max(duration, 0.01), curve: curve) {
            self.canvasContainer.transform = transform
        }
        animator.startAnimation()
    }
}
#endif
