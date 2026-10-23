// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Record on device: the remote keys pressed during the recording window, as
// the dashboard's recording endpoint takes them. UIKit-free.
import Foundation

/// One key press: whole milliseconds from the recording's first key-down.
struct RecordedKey: Encodable, Equatable, Sendable {
    let key: String
    let downMs: Int
    let upMs: Int
}

struct GestureRecorder {
    static let maxEvents = 32
    static let duration: TimeInterval = 10

    private var firstDown: TimeInterval?
    private var presses: [(key: String, down: TimeInterval, up: TimeInterval?)] = []
    private var open: [ObjectIdentifier: Int] = [:]

    /// Unmapped keys are dropped; a `cancelled` ends a press like an `up`.
    /// Presses past the 32nd are dropped.
    mutating func feed(_ event: TvKeyEvent) {
        guard let key = event.key else { return }
        switch event.phase {
        case .down:
            guard open[event.press] == nil, presses.count < Self.maxEvents else { return }
            if firstDown == nil { firstDown = event.at }
            open[event.press] = presses.count
            presses.append((key, event.at, nil))
        case .up, .cancelled:
            guard let index = open.removeValue(forKey: event.press) else { return }
            presses[index].up = event.at
        }
    }

    /// The presses so far. A key still held ends at `now`.
    func finish(now: TimeInterval) -> [RecordedKey] {
        guard let first = firstDown else { return [] }
        func ms(_ time: TimeInterval) -> Int { max(0, Int(((time - first) * 1000).rounded())) }
        return presses.map { press in
            RecordedKey(key: press.key, downMs: ms(press.down), upMs: max(ms(press.down), ms(press.up ?? now)))
        }
    }
}
