// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import UIKit
import SwiftUI
import AVFoundation
import EverframeKit

final class RailsController: UICollectionViewController {
    private let probe = FrameProbe()
    private let posters = (0..<80).map(PosterArt.make)
    private var swiftUIHeader: UIHostingController<HeaderCard>?
    init() {
        let layout = UICollectionViewCompositionalLayout { _, _ in
            let item = NSCollectionLayoutItem(layoutSize: .init(widthDimension: .absolute(280), heightDimension: .absolute(190)))
            let group = NSCollectionLayoutGroup.horizontal(layoutSize: .init(widthDimension: .absolute(300), heightDimension: .absolute(190)), subitems: [item])
            let section = NSCollectionLayoutSection(group: group)
            section.orthogonalScrollingBehavior = .continuous
            section.contentInsets = .init(top: 25, leading: 60, bottom: 25, trailing: 60)
            return section
        }
        super.init(collectionViewLayout: layout)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.035, green: 0.05, blue: 0.09, alpha: 1)
        collectionView.backgroundColor = view.backgroundColor
        collectionView.contentInset.top = 150
        collectionView.register(PosterCell.self, forCellWithReuseIdentifier: "poster")
        collectionView.remembersLastFocusedIndexPath = true
        let title = UILabel(frame: CGRect(x: 60, y: 20, width: 950, height: 110))
        title.text = "EVERFRAME TV  ·  CINEMA COLLECTION"
        title.font = .boldSystemFont(ofSize: 36); title.textColor = .white
        view.addSubview(title)
        // The sensitive label is masked in screenshots and replay; the player
        // layer is additionally opaque in replay (never a movie recording).
        let secret = UILabel(frame: CGRect(x: 1120, y: 35, width: 240, height: 75))
        secret.text = "PRIVATE 7391"; secret.textAlignment = .center
        secret.backgroundColor = .magenta; secret.textColor = .white
        secret.everframe_isSensitive = true; view.addSubview(secret)
        let video = AVPlayerLayer()
        video.frame = CGRect(x: 1420, y: 35, width: 200, height: 75)
        video.backgroundColor = UIColor.red.cgColor; view.layer.addSublayer(video)
        if ProcessInfo.processInfo.environment["REPLAY_TV_SWIFTUI"] == "1" {
            let host = UIHostingController(rootView: HeaderCard())
            addChild(host); host.view.frame = CGRect(x: 60, y: 20, width: 950, height: 110)
            view.addSubview(host.view); host.didMove(toParent: self); swiftUIHeader = host
        }
        if ProcessInfo.processInfo.environment["REPLAY_TV_AUTOSCROLL"] == "1" {
            probe.animate = { [weak self] time in self?.animateRails(time) }
        }
        probe.start()
    }
    override func numberOfSections(in collectionView: UICollectionView) -> Int { 12 }
    override func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { 40 }
    override func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "poster", for: indexPath) as! PosterCell
        cell.image.image = posters[(indexPath.section * 13 + indexPath.item) % posters.count]
        cell.label.text = "Collection \(indexPath.section + 1)  ·  Film \(indexPath.item + 1)"
        cell.accessibilityIdentifier = "poster-\(indexPath.section)-\(indexPath.item)"
        cell.accessibilityLabel = cell.label.text
        return cell
    }
    override func collectionView(_ collectionView: UICollectionView, didUpdateFocusIn context: UICollectionViewFocusUpdateContext,
                                 with coordinator: UIFocusAnimationCoordinator) {
        // Optional collection delegate callback; UICollectionViewController has
        // no superclass implementation to forward to on tvOS.
        probe.focused()
    }
    private func animateRails(_ time: Double) {
        guard time > 0 else { return }
        // Identical deterministic motion for OFF/5/10 comparisons. Real remote
        // focus behavior is validated separately by RemoteRailTests.
        let maxY = max(0, collectionView.contentSize.height - collectionView.bounds.height)
        collectionView.setContentOffset(CGPoint(x: 0, y: -150 + (sin(time * 0.22) + 1) * 0.5 * maxY), animated: false)
        func scrollChildren(_ parent: UIView) {
            for child in parent.subviews {
                if let scroll = child as? UIScrollView, scroll !== collectionView,
                   scroll.contentSize.width > scroll.bounds.width + 100 {
                    let maxX = min(2200, scroll.contentSize.width - scroll.bounds.width)
                    scroll.setContentOffset(CGPoint(x: (sin(time * 0.55) + 1) * 0.5 * maxX, y: 0), animated: false)
                } else { scrollChildren(child) }
            }
        }
        scrollChildren(collectionView)
    }
}

private final class PosterCell: UICollectionViewCell {
    let image = UIImageView()
    let label = UILabel()
    override init(frame: CGRect) {
        super.init(frame: frame)
        image.frame = CGRect(x: 0, y: 0, width: 280, height: 155)
        image.contentMode = .scaleAspectFill; image.clipsToBounds = true; image.layer.cornerRadius = 12
        image.adjustsImageWhenAncestorFocused = true; contentView.addSubview(image)
        label.frame = CGRect(x: 2, y: 160, width: 278, height: 28)
        label.font = .systemFont(ofSize: 20, weight: .medium); label.textColor = .white
        contentView.addSubview(label); isAccessibilityElement = true
    }
    required init?(coder: NSCoder) { fatalError("Use init(frame:)") }
    override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
        super.didUpdateFocus(in: context, with: coordinator)
        coordinator.addCoordinatedAnimations {
            self.transform = self.isFocused ? CGAffineTransform(scaleX: 1.06, y: 1.06) : .identity
            self.label.textColor = self.isFocused ? .cyan : .white
        }
    }
}

private struct HeaderCard: View {
    var body: some View {
        HStack(spacing: 24) {
            Image(systemName: "play.rectangle.fill").font(.system(size: 56)).foregroundStyle(.cyan)
            VStack(alignment: .leading) {
                Text("SwiftUI · Tonight’s selection").font(.title2).bold()
                Text("EverframeFocus, browse and discover").font(.headline).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(Color(red: 0.035, green: 0.05, blue: 0.09))
    }
}

private enum PosterArt {
    static func make(_ index: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: 560, height: 310), format: format).image { context in
            let cg = context.cgContext
            let hue = CGFloat((index * 37) % 100) / 100
            let colors = [UIColor(hue: hue, saturation: 0.8, brightness: 0.7, alpha: 1).cgColor,
                          UIColor(hue: hue, saturation: 0.6, brightness: 0.14, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            cg.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 560, y: 310), options: [])
            for shape in 0..<20 {
                cg.setFillColor(UIColor(white: CGFloat(shape % 5) / 5, alpha: 0.22).cgColor)
                let x = (index * 31 + shape * 79) % 530, y = (index * 17 + shape * 47) % 270
                cg.fillEllipse(in: CGRect(x: x, y: y, width: 100, height: 100))
            }
            let title = ["NORTHBOUND", "AFTER HOURS", "THE HORIZON", "DEEP BLUE", "WILD EARTH"][index % 5]
            (title as NSString).draw(at: CGPoint(x: 28, y: 210), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 38), .foregroundColor: UIColor.white])
            ("A EVERFRAME ORIGINAL  •  \(2020 + index % 7)" as NSString).draw(at: CGPoint(x: 30, y: 265), withAttributes: [.font: UIFont.systemFont(ofSize: 17), .foregroundColor: UIColor.white])
        }
    }
}
