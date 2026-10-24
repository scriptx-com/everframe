// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Recognizes the app's TV binding in a stream of remote key events, and says
// which presses belong to a fired gesture (so a linked device can keep them
// from the app). UIKit-free and host-testable; `TvGestureInput` feeds it from
// `UIWindow.sendEvent`.
//
// tvOS delivers one `began` and one `ended` per press, with no key repeat
// (measured in the tvOS press probe), so only a timer completes a long press:
// a `down` asks for `holdDeadline`, and the caller calls `holdTimerFired`.
import Foundation

enum TvKeyPhase: Equatable, Sendable { case down, up, cancelled }

/// One press phase. `key` is the contract name (nil when unmapped), `press`
/// the `UIPress` identity, and `at` its timestamp (`UIPress.timestamp`, the
/// `ProcessInfo.systemUptime` clock).
struct TvKeyEvent: Equatable, Sendable {
    let key: String?
    let phase: TvKeyPhase
    let press: ObjectIdentifier
    let at: TimeInterval
}

/// What the detector says about one event. `consume` means the press belongs
/// to a fired gesture; the caller keeps it from the app only on a linked device.
struct TvKeyVerdict: Equatable, Sendable {
    var fire = false
    var consume = false
    var holdDeadline: TimeInterval? = nil

    static let pass = TvKeyVerdict()
}

struct TvGestureDetector {
    /// Whether the release of a fired long press is kept from the app on a
    /// linked device. The press probe (spike row 2) showed SwiftUI's
    /// `onPlayPauseCommand` acting on the release, even after a 1.6 s hold, so
    /// delivering it would toggle playback a second time; row 3 showed no
    /// target left stuck when that release never arrived.
    static let consumesFiredHoldRelease = true

    let binding: TvGestureBinding

    /// Timer tolerance: a timer may run a hair before the deadline it was set for.
    private static let deadlineSlack: TimeInterval = 0.001

    private var hold: (press: ObjectIdentifier, deadline: TimeInterval, fired: Bool)?
    private var steps: [(key: String?, at: TimeInterval)] = []
    private var held: [ObjectIdentifier: String] = [:]
    /// Presses of a fired sequence or chord, consumed until their own release.
    private var consumed: Set<ObjectIdentifier> = []

    init(binding: TvGestureBinding) {
        self.binding = binding
    }

    mutating func feed(_ event: TvKeyEvent) -> TvKeyVerdict {
        if event.phase != .down {
            return release(event)
        }
        switch binding {
        case let .longPress(key, holdMs):
            guard event.key == key else { return .pass }
            let deadline = event.at + Double(holdMs) / 1000
            hold = (event.press, deadline, false)
            return TvKeyVerdict(holdDeadline: deadline)
        case let .sequence(keys, windowMs):
            steps.append((event.key, event.at))
            if steps.count > keys.count { steps.removeFirst(steps.count - keys.count) }
            guard steps.count == keys.count, steps.map(\.key) == keys.map(Optional.some),
                  let first = steps.first, event.at - first.at <= Double(windowMs) / 1000 + Self.deadlineSlack
            else { return .pass }
            steps.removeAll()
            consumed.insert(event.press)
            return TvKeyVerdict(fire: true, consume: true)
        case let .chord(keys):
            guard let key = event.key, keys.contains(key) else { return .pass }
            held[event.press] = key
            guard Set(held.values).isSuperset(of: keys) else { return .pass }
            // A completion while an earlier one is still held belongs to the
            // same gesture: consumed, never a second capture.
            let alreadyFired = !consumed.isDisjoint(with: held.keys)
            consumed.insert(event.press)
            return TvKeyVerdict(fire: !alreadyFired, consume: true)
        }
    }

    private mutating func release(_ event: TvKeyEvent) -> TvKeyVerdict {
        held.removeValue(forKey: event.press)
        if let current = hold, current.press == event.press {
            hold = nil
            return current.fired && Self.consumesFiredHoldRelease ? TvKeyVerdict(consume: true) : .pass
        }
        if consumed.remove(event.press) != nil { return TvKeyVerdict(consume: true) }
        return .pass
    }

    /// A long press is down and has not fired yet.
    var isHoldPending: Bool { hold.map { !$0.fired } ?? false }

    /// The hold timer ran. Fires once, only while the press that asked for
    /// it is still down and its deadline has passed.
    mutating func holdTimerFired(at now: TimeInterval) -> (fired: Bool, press: ObjectIdentifier?) {
        guard let current = hold, !current.fired, now + Self.deadlineSlack >= current.deadline else {
            return (false, nil)
        }
        hold?.fired = true
        return (true, current.press)
    }

    /// Stands aside (a text input is being edited): forgets an unfired hold,
    /// the sequence's steps and the chord's held keys, and keeps the presses
    /// of a fired gesture consumed until their own release.
    mutating func dropPending() {
        if hold?.fired != true { hold = nil }
        steps.removeAll()
        held.removeAll()
    }

    mutating func reset() {
        hold = nil
        steps.removeAll()
        held.removeAll()
        consumed.removeAll()
    }
}
