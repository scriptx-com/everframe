// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

#if os(tvOS)
import UIKit
import SwiftUI
import AVKit
import AVFoundation

/// Opt-in remote press probe (`REPLAY_TV_PRESS_PROBE=1`). It records what the
/// Siri Remote delivers to a window and what four common Play/Pause targets do
/// with it, so a quick-capture gesture can be designed against measured
/// behavior. It uses no media and no credentials: the player's 10 s movie is
/// written at launch from procedural frames.
///
/// Log lines go to `NSLog` and to `press-probe.log` in the app's caches:
/// - `EvfTvProbe type=<pressName> phase=<began|ended|cancelled> t=<ms> focus=<id>`:
///   a press as it reached `ProbeWindow.sendEvent`, before any SDK hook runs.
///   `dropped=1` marks a press the probe withheld (`REPLAY_TV_PROBE_DROP`).
/// - `EvfTvProbe action=<target>:<event> t=<ms>`: what a target did, and
///   `action=app:<pressName>-<phase>` for a press that reached the app's views
///   (after the window and any SDK hook let it through).
enum PressProbe {
    static let enabled = ProcessInfo.processInfo.environment["REPLAY_TV_PRESS_PROBE"] == "1"
    private static let started = ProcessInfo.processInfo.systemUptime
    private static let queue = DispatchQueue(label: "dev.everframe.replaytv.press-probe")

    static func ms(_ uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Int {
        Int(((uptime - started) * 1000).rounded())
    }

    static func log(_ line: String) {
        let text = "EvfTvProbe " + line
        NSLog("%@", text)
        let url = ProbeFiles.url("press-probe.log")
        queue.async {
            let data = Data((text + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    static func action(_ target: String, _ event: String) {
        log("action=\(target):\(event) t=\(ms())")
    }

    static func pressName(_ type: UIPress.PressType) -> String {
        switch type {
        case .upArrow: return "up"
        case .downArrow: return "down"
        case .leftArrow: return "left"
        case .rightArrow: return "right"
        case .select: return "select"
        case .menu: return "menu"
        case .playPause: return "playPause"
        default:
            if #available(tvOS 14.3, *), type == .pageUp { return "pageUp" }
            if #available(tvOS 14.3, *), type == .pageDown { return "pageDown" }
            return "type\(type.rawValue)"
        }
    }

    static func phaseName(_ phase: UIPress.Phase) -> String? {
        switch phase {
        case .began: return "began"
        case .ended: return "ended"
        case .cancelled: return "cancelled"
        default: return nil
        }
    }

    /// The accessibility identifier of the focused view or its nearest ancestor.
    @MainActor static func focusID(in window: UIWindow) -> String {
        var view = UIFocusSystem.focusSystem(for: window)?.focusedItem as? UIView
        while let current = view {
            if let id = current.accessibilityIdentifier, !id.isEmpty {
                return id == "probe-swiftui-host" ? "probe-swiftui" : id
            }
            view = current.superview
        }
        return "none"
    }
}

/// Drops presses named by `REPLAY_TV_PROBE_DROP` (`<pressName>:<began|ended>`,
/// comma-separated) by not calling `super.sendEvent`, which is how an SDK
/// would swallow them. Logs every press first.
final class ProbeWindow: UIWindow {
    private let drops: Set<String> = Set(
        (ProcessInfo.processInfo.environment["REPLAY_TV_PROBE_DROP"] ?? "")
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })

    override func sendEvent(_ event: UIEvent) {
        guard let presses = event as? UIPressesEvent else { return super.sendEvent(event) }
        let focus = PressProbe.focusID(in: self)
        var changing = 0
        var dropped = 0
        for press in presses.allPresses {
            guard let phase = PressProbe.phaseName(press.phase) else { continue }
            let name = PressProbe.pressName(press.type)
            changing += 1
            let drop = drops.contains("\(name):\(phase)")
            if drop { dropped += 1 }
            PressProbe.log("type=\(name) phase=\(phase) t=\(PressProbe.ms(press.timestamp)) focus=\(focus)"
                + (drop ? " dropped=1" : ""))
        }
        if changing > 0, dropped == changing { return }
        super.sendEvent(event)
    }
}

/// Observes presses that reached the app's views. It never recognizes and never
/// delays or cancels anything.
private final class PressObserver: UIGestureRecognizer {
    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        allowedTouchTypes = []
        allowedPressTypes = [UIPress.PressType.upArrow, .downArrow, .leftArrow, .rightArrow, .select, .menu, .playPause]
            .map { NSNumber(value: $0.rawValue) }
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent) { record(presses, "began") }
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent) {
        record(presses, "ended")
        state = .failed
    }
    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent) {
        record(presses, "cancelled")
        state = .failed
    }
    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    private func record(_ presses: Set<UIPress>, _ phase: String) {
        for press in presses { PressProbe.action("app", "\(PressProbe.pressName(press.type))-\(phase)") }
    }
}

/// A focusable view that only a Play/Pause tap recognizer acts on.
private final class FocusableTapView: UIView {
    override var canBecomeFocused: Bool { true }
    override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
        super.didUpdateFocus(in: context, with: coordinator)
        coordinator.addCoordinatedAnimations { self.layer.borderWidth = self.isFocused ? 8 : 0 }
    }
}

/// Logs every playback request the player view controller makes.
private final class LoggingPlayer: AVPlayer {
    override func play() { PressProbe.action("player", "play"); super.play() }
    override func pause() { PressProbe.action("player", "pause"); super.pause() }
    override var rate: Float {
        get { super.rate }
        set { PressProbe.action("player", "rate=\(newValue)"); super.rate = newValue }
    }
}

private struct ProbeSwiftUIView: View {
    var body: some View {
        Button("SwiftUI") { PressProbe.action("swiftui", "select") }
            .accessibilityIdentifier("probe-swiftui")
            .onPlayPauseCommand { PressProbe.action("swiftui", "playPause") }
    }
}

final class PressProbeController: UIViewController {
    private let player = LoggingPlayer()
    private let playerController = AVPlayerViewController()
    /// The focused target's id, for the UI test (`probe-focus`): an embedded
    /// player or a SwiftUI button keeps focus on an inner element.
    private let focusLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.035, green: 0.05, blue: 0.09, alpha: 1)
        view.addGestureRecognizer(PressObserver(target: nil, action: nil))
        // Keep the probe in the foreground: Menu on the root would leave the app.
        let menu = UITapGestureRecognizer(target: self, action: #selector(menuPressed))
        menu.allowedPressTypes = [NSNumber(value: UIPress.PressType.menu.rawValue)]
        view.addGestureRecognizer(menu)

        let button = UIButton(type: .system)
        button.setTitle("Button", for: .normal)
        button.accessibilityIdentifier = "probe-button"
        button.addTarget(self, action: #selector(buttonPrimary), for: .primaryActionTriggered)

        let tapView = FocusableTapView()
        tapView.backgroundColor = .darkGray
        tapView.layer.borderColor = UIColor.cyan.cgColor
        tapView.layer.cornerRadius = 12
        tapView.accessibilityIdentifier = "probe-tap"
        tapView.isAccessibilityElement = true
        tapView.accessibilityLabel = "Tap target"
        let tap = UITapGestureRecognizer(target: self, action: #selector(playPauseTapped))
        tap.allowedPressTypes = [NSNumber(value: UIPress.PressType.playPause.rawValue)]
        tapView.addGestureRecognizer(tap)

        playerController.player = player
        addChild(playerController)
        playerController.view.accessibilityIdentifier = "probe-player"
        playerController.didMove(toParent: self)

        let swiftUI = UIHostingController(rootView: ProbeSwiftUIView())
        addChild(swiftUI)
        swiftUI.view.backgroundColor = .clear
        swiftUI.view.accessibilityIdentifier = "probe-swiftui-host"
        swiftUI.didMove(toParent: self)

        let row = UIStackView(arrangedSubviews: [button, tapView, playerController.view, swiftUI.view])
        row.axis = .horizontal
        row.spacing = 60
        row.distribution = .fillEqually
        row.alignment = .center
        row.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(row)
        NSLayoutConstraint.activate([
            row.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            row.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 90),
            row.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -90),
            tapView.heightAnchor.constraint(equalToConstant: 240),
            playerController.view.heightAnchor.constraint(equalToConstant: 240),
            swiftUI.view.heightAnchor.constraint(equalToConstant: 240),
        ])

        focusLabel.frame = CGRect(x: 90, y: 60, width: 900, height: 50)
        focusLabel.textColor = .white
        focusLabel.font = .systemFont(ofSize: 30)
        focusLabel.accessibilityIdentifier = "probe-focus"
        focusLabel.text = "none"
        view.addSubview(focusLabel)

        ProbeMovie.make { [weak self] url in
            guard let self, let url else { PressProbe.action("player", "movie-failed"); return }
            self.player.replaceCurrentItem(with: AVPlayerItem(url: url))
            PressProbe.action("player", "ready")
        }
        PressProbe.action("probe", "launched")
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] {
        view.subviews.first.map { [$0] } ?? []
    }

    override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
        super.didUpdateFocus(in: context, with: coordinator)
        guard let window = view.window else { return }
        let id = PressProbe.focusID(in: window)
        focusLabel.text = id
        focusLabel.accessibilityLabel = id
        PressProbe.action("focus", id)
    }

    @objc private func buttonPrimary() { PressProbe.action("button", "primary") }
    @objc private func playPauseTapped() { PressProbe.action("tap", "playPause") }
    @objc private func menuPressed() { PressProbe.action("root", "menu") }
}

/// Writes a 10 s, 320×180 H.264 movie of procedural frames into the caches.
private enum ProbeMovie {
    static func make(_ done: @escaping @MainActor (URL?) -> Void) {
        let url = ProbeFiles.url("probe-movie.mov")
        try? FileManager.default.removeItem(at: url)
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else {
            Task { @MainActor in done(nil) }
            return
        }
        let width = 320, height = 180, fps: Int32 = 10
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        guard writer.startWriting() else {
            Task { @MainActor in done(nil) }
            return
        }
        writer.startSession(atSourceTime: .zero)
        let frames = Int(fps) * 10
        let box = WriterBox(writer: writer, input: input, adaptor: adaptor)
        input.requestMediaDataWhenReady(on: DispatchQueue(label: "dev.everframe.replaytv.probe-movie")) {
            while box.input.isReadyForMoreMediaData, box.frame < frames {
                guard let pool = box.adaptor.pixelBufferPool else { break }
                var buffer: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
                guard let buffer else { break }
                fill(buffer, frame: box.frame, width: width, height: height)
                box.adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(box.frame), timescale: fps))
                box.frame += 1
            }
            if box.frame >= frames, !box.finished {
                box.finished = true
                box.input.markAsFinished()
                box.writer.finishWriting {
                    let ok = box.writer.status == .completed
                    Task { @MainActor in done(ok ? url : nil) }
                }
            }
        }
    }

    private static func fill(_ buffer: CVPixelBuffer, frame: Int, width: Int, height: Int) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        let pixels = base.assumingMemoryBound(to: UInt8.self)
        let bar = (frame * 8) % width
        for y in 0..<height {
            for x in 0..<width {
                let offset = y * stride + x * 4
                let inBar = abs(x - bar) < 12
                pixels[offset] = inBar ? 255 : UInt8((x + frame) % 256)
                pixels[offset + 1] = inBar ? 255 : UInt8((y * 2) % 256)
                pixels[offset + 2] = inBar ? 255 : UInt8((frame * 3) % 256)
                pixels[offset + 3] = 255
            }
        }
    }

    private final class WriterBox: @unchecked Sendable {
        let writer: AVAssetWriter
        let input: AVAssetWriterInput
        let adaptor: AVAssetWriterInputPixelBufferAdaptor
        var frame = 0
        var finished = false
        init(writer: AVAssetWriter, input: AVAssetWriterInput, adaptor: AVAssetWriterInputPixelBufferAdaptor) {
            self.writer = writer
            self.input = input
            self.adaptor = adaptor
        }
    }
}
#endif
