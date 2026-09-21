// packages/sdk-ios/Sources/TraceItXReporterUI/AreaCaptureViewController.swift
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 9 — area capture. A full-screen, transparent overlay presented in its
// OWN UIWindow at windowLevel = .alert + 2 (above the — at this point HIDDEN
// — reporter window, which sits at .alert + 1; see ReporterWindowController)
// so the host app's real UI is visible and draggable-over underneath.
//
// This view controller ONLY owns the drag-to-select UI. It hands the
// selection rect back via `onCapture` — in ITS OWN view's coordinate space,
// which is the same coordinate space as the host window's `.bounds` (both
// windows are full-screen on the same UIWindowScene) — and the caller
// (TXReporterViewController.startAreaCapture/completeAreaCapture) does the
// actual host-window capture, sensitive-rect masking, and pixel-space crop
// (see Annotation/AreaCropMath.swift), then restores the reporter with the
// crop as a new shot.
//
// Copy matches web sdk-react/reporter-ui/AreaCaptureOverlay.tsx ("Drag to
// select an area", "Cancel", "Capture visible area"). The web build offers a
// separate always-enabled full-viewport capture action; this native surface
// instead disables "Capture visible area" until a rect ≥ 8×8pt has been
// dragged (CONTEXT: no separate full-viewport shortcut on iOS — the host
// window IS the visible area, so a full-viewport option would just be "drag
// a rect that covers the whole screen").
#if canImport(UIKit) && !os(tvOS)
import UIKit

@MainActor
final class AreaCaptureViewController: UIViewController {

    /// Drags smaller than this (either edge, in points) don't produce a
    /// usable selection — mirrors web's `MIN_DRAG_EDGE`.
    static let minDragEdge: CGFloat = 8

    private let onCapture: (CGRect) -> Void
    private let onCancel: () -> Void

    /// Injected by the host (ReporterViewController.startAreaCapture)
    /// immediately after construction, before `overlayWindow.makeKeyAndVisible()`
    /// — viewDidLoad (where every reference below is read) runs at
    /// presentation, strictly after that assignment.
    var palette: ResolvedPalette = .brand

    /// 40%-black dimming layer; a `CAShapeLayer` mask (even-odd fill) punches
    /// a transparent hole over the current selection so the host UI beneath
    /// reads clearly there while everything else stays dimmed.
    private let dimView = UIView()
    private let maskLayer = CAShapeLayer()
    private let selectionView = UIView()
    private let hintLabel = UILabel()
    private let bar = UIView()
    private let cancelButton = UIButton(type: .system)
    private let captureButton = UIButton(type: .system)

    /// Current selection, in `view` coordinates. `.zero` (empty) until the
    /// first drag produces a non-empty rect.
    private var selection: CGRect = .zero
    private var dragStart: CGPoint?

    init(onCapture: @escaping (CGRect) -> Void, onCancel: @escaping () -> Void) {
        self.onCapture = onCapture
        self.onCancel = onCancel
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        dimView.isUserInteractionEnabled = false
        dimView.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        view.addSubview(dimView)

        selectionView.isUserInteractionEnabled = false
        selectionView.isHidden = true
        selectionView.backgroundColor = .clear
        selectionView.layer.borderWidth = 1
        selectionView.layer.borderColor = palette.accent.cgColor
        view.addSubview(selectionView)

        hintLabel.text = "Drag to select an area"
        hintLabel.textColor = palette.ink
        hintLabel.font = .systemFont(ofSize: 15, weight: .medium)
        hintLabel.textAlignment = .center
        hintLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hintLabel)
        NSLayoutConstraint.activate([
            hintLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            hintLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])

        layoutBar()

        // Web parity: the bar's own buttons handle their own taps; the pan
        // gesture only starts a drag when the touch lands on the open
        // surface (mirrors AreaCaptureOverlay.tsx's `.closest('.txx-area-
        // capture-bar')` bail-out). Without the delegate check, a
        // UIPanGestureRecognizer on the same view as the buttons can steal
        // the touch before their touchUpInside fires.
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.delegate = self
        view.addGestureRecognizer(pan)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        dimView.frame = view.bounds
        updateMask()
    }

    private func layoutBar() {
        // Quiet-instrument bar — web `.txx-area-capture-bar`: `background:
        // var(--txx-surface); border: 1px solid var(--txx-border);
        // border-radius: var(--txx-radius-lg)`. The old 22pt pill radius
        // matched the retired bento-duo-blue "floating capsule" look; the
        // quiet pass uses the same calm rounded-rect card radius as every
        // other bg3 panel (palette pill, history buttons).
        bar.backgroundColor = palette.bg3
        bar.layer.cornerRadius = 10  // cards radius
        bar.layer.borderWidth = 1
        bar.layer.borderColor = palette.hair.cgColor
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)

        var cancelCfg = UIButton.Configuration.plain()
        cancelCfg.baseForegroundColor = palette.ink
        cancelCfg.attributedTitle = AttributedString(
            "Cancel",
            attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 15, weight: .semibold)])
        )
        cancelButton.configuration = cancelCfg
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        var captureCfg = UIButton.Configuration.filled()
        captureCfg.baseBackgroundColor = palette.accent
        // Dark accentFg text on the amber fill (web `.txx-btn-primary`:
        // `color: var(--txx-accent-fg)`) — matches Send/Done.
        captureCfg.baseForegroundColor = palette.accentFg
        captureCfg.attributedTitle = AttributedString(
            "Capture visible area",
            attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 15, weight: .semibold)])
        )
        captureCfg.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16)
        captureCfg.background.cornerRadius = 8  // controls radius
        captureButton.configuration = captureCfg
        captureButton.isEnabled = false
        // UIButton.Configuration doesn't auto-dim a custom filled background
        // on `.disabled` the way the system tint does — drive it explicitly.
        captureButton.configurationUpdateHandler = { button in
            button.alpha = button.isEnabled ? 1.0 : 0.4
        }
        captureButton.addTarget(self, action: #selector(captureTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [cancelButton, captureButton])
        stack.axis = .horizontal
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(stack)

        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            bar.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            bar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: bar.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -8),
        ])
    }

    @objc private func handlePan(_ gr: UIPanGestureRecognizer) {
        let point = gr.location(in: view)
        switch gr.state {
        case .began:
            dragStart = point
            hintLabel.isHidden = true
            selectionView.isHidden = false
        case .changed:
            guard let dragStart else { return }
            selection = CGRect(
                x: min(dragStart.x, point.x), y: min(dragStart.y, point.y),
                width: abs(point.x - dragStart.x), height: abs(point.y - dragStart.y)
            )
            selectionView.frame = selection
            updateMask()
            captureButton.isEnabled = selection.width >= Self.minDragEdge && selection.height >= Self.minDragEdge
        case .ended, .cancelled, .failed:
            dragStart = nil
        default:
            break
        }
    }

    private func updateMask() {
        let path = UIBezierPath(rect: view.bounds)
        if !selection.isEmpty {
            path.append(UIBezierPath(rect: selection))
        }
        maskLayer.path = path.cgPath
        maskLayer.fillRule = .evenOdd
        dimView.layer.mask = maskLayer
    }

    @objc private func cancelTapped() {
        onCancel()
    }

    @objc private func captureTapped() {
        guard selection.width >= Self.minDragEdge, selection.height >= Self.minDragEdge else { return }
        onCapture(selection)
    }
}

extension AreaCaptureViewController: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        !bar.frame.contains(touch.location(in: view))
    }
}
#endif
