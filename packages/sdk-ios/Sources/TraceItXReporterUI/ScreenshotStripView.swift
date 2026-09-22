// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// ScreenshotStripView — horizontal thumbnail rail above the active-shot
// preview (Task 7, native report-window parity). One 72×48pt rounded tile
// per `ReporterShot` (active tile gets a 2pt accent border, others 1pt
// hair), each with a 20pt "×" delete badge top-right; a trailing dashed-
// border add tile (hidden once the shot count hits
// ShotListOps.maxShots) starts the next capture.
//
// Visual reference: packages/sdk-react/src/reporter-ui/ScreenshotStrip.tsx
// (`.txx-shot-strip` / `.txx-shot-thumb` / `.txx-shot-delete` /
// `.txx-shot-add`) — same accessible-name copy ("Delete screenshot N",
// "Add another screenshot") for cross-platform parity (web QA lock).
//
// Stateless view: the host (TXReporterViewController) is the single source
// of truth for `shots`/`activeShotIndex` and drives this view via
// `update(thumbnails:activeIndex:showAddTile:)` on every mutation. This view
// never mutates host state directly — it only reports intent through the
// three callbacks.
#if canImport(UIKit) && !os(tvOS)
import UIKit

@MainActor
public final class ScreenshotStripView: UIView {

    // MARK: - Callbacks

    /// Fired with the tapped tile's index (0-based, matches `shots`).
    public var onSelect: ((Int) -> Void)?
    /// Fired with the tapped delete-badge's index. The host decides whether
    /// to confirm (annotated shot) or delete immediately (blank shot).
    public var onDelete: ((Int) -> Void)?
    /// Fired when the trailing add tile is tapped.
    public var onAdd: (() -> Void)?

    /// Injected by the host (ReporterViewController.viewDidLoad) BEFORE any
    /// layout call that reads colors. `addTileView` is `lazy`, so as long as
    /// its first access (inside `update(...)`) happens after this is set,
    /// its construction-time `DashedBorderButton(strokeColor:)` read sees
    /// the injected value, not `.brand`.
    public var palette: ResolvedPalette = .brand

    private static let tileSize = CGSize(width: 72, height: 48)
    /// Mirrors `ShotListOps.maxShots` — the add tile hides once
    /// `thumbnails.count` reaches this. Kept as a private literal (rather
    /// than importing the pure-logic constant) since this view has no
    /// compile-time dependency on the Annotation module's internal types.
    private static let maxShots = 5

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private lazy var addTileView: UIView = buildAddTile()

    public override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    private func setup() {
        translatesAutoresizingMaskIntoConstraints = false

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        addSubview(scroll)

        stack.axis = .horizontal
        stack.spacing = 8
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)

        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Self.tileSize.height),

            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: bottomAnchor),

            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.heightAnchor),
        ])
    }

    // MARK: - Public API

    /// Rebuilds every tile. Cheap enough to call on every shot mutation
    /// (add / delete / select / re-annotate) — tile count is capped at
    /// `maxShots` (5), so the rebuild is at most 6 subviews.
    public func update(thumbnails: [UIImage], activeIndex: Int, showAddTile: Bool) {
        for v in stack.arrangedSubviews {
            stack.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        for (i, image) in thumbnails.enumerated() {
            let tile = buildTile(image: image, index: i, total: thumbnails.count, isActive: i == activeIndex)
            stack.addArrangedSubview(tile)
        }
        if showAddTile && thumbnails.count < Self.maxShots {
            stack.addArrangedSubview(addTileView)
        }
    }

    // MARK: - Tile construction

    private func buildTile(image: UIImage, index: Int, total: Int, isActive: Bool) -> UIView {
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.widthAnchor.constraint(equalToConstant: Self.tileSize.width).isActive = true
        container.heightAnchor.constraint(equalToConstant: Self.tileSize.height).isActive = true

        let imageView = UIImageView(image: image)
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.layer.cornerRadius = 8
        imageView.layer.borderWidth = isActive ? 2 : 1
        imageView.layer.borderColor = (isActive ? palette.accent : palette.hair).cgColor
        container.addSubview(imageView)

        // Whole-tile transparent button — the select tap target. Sits
        // beneath the delete badge in z-order so the badge's smaller hit
        // area wins where the two overlap.
        let selectButton = UIButton(type: .custom)
        selectButton.translatesAutoresizingMaskIntoConstraints = false
        selectButton.backgroundColor = .clear
        selectButton.accessibilityLabel = "Screenshot \(index + 1) of \(total)"
        selectButton.addAction(UIAction { [weak self] _ in self?.onSelect?(index) }, for: .touchUpInside)
        container.addSubview(selectButton)

        let deleteBadge = buildDeleteBadge(index: index)
        container.addSubview(deleteBadge)

        NSLayoutConstraint.activate([
            imageView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: container.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            selectButton.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            selectButton.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            selectButton.topAnchor.constraint(equalTo: container.topAnchor),
            selectButton.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            deleteBadge.topAnchor.constraint(equalTo: container.topAnchor, constant: 2),
            deleteBadge.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -2),
            deleteBadge.widthAnchor.constraint(equalToConstant: 20),
            deleteBadge.heightAnchor.constraint(equalToConstant: 20),
        ])

        return container
    }

    private func buildDeleteBadge(index: Int) -> UIButton {
        var cfg = UIButton.Configuration.plain()
        cfg.baseForegroundColor = palette.ink
        cfg.contentInsets = .zero
        cfg.attributedTitle = AttributedString(
            "×",
            attributes: AttributeContainer([
                .font: UIFont.systemFont(ofSize: 13, weight: .semibold),
                .foregroundColor: palette.ink,
            ])
        )
        let button = UIButton(configuration: cfg)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.backgroundColor = palette.bg3
        button.layer.cornerRadius = 10
        button.clipsToBounds = true
        // Web copy parity (ScreenshotStrip.tsx `Delete screenshot ${i + 1}`).
        button.accessibilityLabel = "Delete screenshot \(index + 1)"
        button.addAction(UIAction { [weak self] _ in self?.onDelete?(index) }, for: .touchUpInside)
        return button
    }

    private func buildAddTile() -> UIView {
        let button = DashedBorderButton(strokeColor: palette.hair)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: Self.tileSize.width).isActive = true
        button.heightAnchor.constraint(equalToConstant: Self.tileSize.height).isActive = true
        var cfg = UIButton.Configuration.plain()
        cfg.image = UIImage(systemName: "plus")?
            .withConfiguration(UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold))
        cfg.baseForegroundColor = palette.accent
        button.configuration = cfg
        button.accessibilityLabel = "Add another screenshot"
        button.addAction(UIAction { [weak self] _ in self?.onAdd?() }, for: .touchUpInside)
        return button
    }
}

/// Dashed-border tile button for the trailing "add screenshot" affordance.
/// Plain UIButton has no dashed-border styling primitive — a CAShapeLayer
/// stroked with `lineDashPattern` redrawn on layout is the standard UIKit
/// approach.
///
/// Relocation (Task 4, iOS spec 2026-08-26): this class's stroke color used
/// to be a `BrandTokens.hair` literal read directly inside `init(frame:)` —
/// a construction-time BrandTokens read with no palette in scope. Since a
/// UIButton subclass has no ambient access to the owning ScreenshotStripView's
/// injected `palette`, the fix is a designated initializer that takes the
/// resolved stroke color as a parameter (`buildAddTile()` passes
/// `palette.hair`) rather than defaulting to `.brand` internally.
@MainActor
private final class DashedBorderButton: UIButton {
    private let dashedLayer = CAShapeLayer()

    init(strokeColor: UIColor) {
        super.init(frame: .zero)
        dashedLayer.strokeColor = strokeColor.cgColor
        dashedLayer.fillColor = UIColor.clear.cgColor
        dashedLayer.lineDashPattern = [4, 3]
        dashedLayer.lineWidth = 1
        layer.addSublayer(dashedLayer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        dashedLayer.frame = bounds
        dashedLayer.path = UIBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), cornerRadius: 8).cgPath
    }
}
#endif
