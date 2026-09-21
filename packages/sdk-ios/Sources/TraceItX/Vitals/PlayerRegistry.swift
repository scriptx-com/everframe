// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Port of PlayerRegistry.kt. Registration is TWO-PHASE: reserve() mints the id
// without publishing it, publish() makes it visible to live(). See the Kotlin
// file for the full account of `announcedIn` (the pin — "where does this
// player's next event go?"), `detached` (teardown COMPLETED, distinct from
// registry liveness), and `announceLock` (orders attach against detach; never
// held across customer code or a rotation callback).
import Foundation
import TraceItXProtocol

final class PlayerRegistry: @unchecked Sendable {
    final class Token: @unchecked Sendable {}

    final class Registration: @unchecked Sendable {
        let id: String
        let name: String?
        let integration: PlayerIntegration
        let token: Token
        /// Orders this registration's player_attach against its player_detach. Lock order: announceLock → registry lock.
        let announceLock = NSLock()
        private let stateLock = NSLock()
        private var _announcedIn: Announced?
        private var _detached = false

        final class Announced {
            let collector: VitalsCollector
            let sessionId: String
            init(collector: VitalsCollector, sessionId: String) {
                self.collector = collector
                self.sessionId = sessionId
            }
        }

        init(id: String, name: String?, integration: PlayerIntegration, token: Token) {
            self.id = id
            self.name = name
            self.integration = integration
            self.token = token
        }

        /// Written only under announceLock; readable from any thread.
        var announcedIn: Announced? {
            get {
                stateLock.lock()
                defer { stateLock.unlock() }
                return _announcedIn
            }
            set {
                stateLock.lock()
                _announcedIn = newValue
                stateLock.unlock()
            }
        }

        var detached: Bool {
            get {
                stateLock.lock()
                defer { stateLock.unlock() }
                return _detached
            }
            set {
                stateLock.lock()
                _detached = newValue
                stateLock.unlock()
            }
        }
    }

    private let lock = NSLock()
    private var counter = 0
    private var liveList: [(Token, Registration)] = []   // insertion-ordered

    func reserve(_ integration: PlayerIntegration, name: String?) -> Registration {
        lock.lock()
        defer { lock.unlock() }
        counter += 1
        return Registration(
            id: "p\(counter)",
            name: name.map { VitalsText.cut($0, toUTF16: VitalsLimits.maxCustomNameLength) },   // UTF-16 units (round-1, #11)
            integration: integration,
            token: Token()
        )
    }

    func publish(_ r: Registration) {
        lock.lock()
        liveList.append((r.token, r))
        lock.unlock()
    }

    func unregister(_ token: Token) -> Registration? {
        lock.lock()
        defer { lock.unlock() }
        guard let i = liveList.firstIndex(where: { $0.0 === token }) else { return nil }
        return liveList.remove(at: i).1
    }

    func isLive(_ token: Token) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return liveList.contains { $0.0 === token }
    }

    func live() -> [Registration] {
        lock.lock()
        defer { lock.unlock() }
        return liveList.map(\.1)
    }

    func clear() -> [Registration] {
        lock.lock()
        defer { lock.unlock() }
        let all = liveList.map(\.1)
        liveList.removeAll()
        return all
    }
}
