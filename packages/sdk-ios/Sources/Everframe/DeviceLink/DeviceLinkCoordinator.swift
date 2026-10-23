// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Links a real device to whoever is waiting on the dashboard.
//
// An unlinked device sends a hello when the capture gesture fires and the app's
// device linking is on. The server answers `none` (nobody is linking: stop) or
// `pending` with a matching number. On `pending` the device shows the banner
// and checks the attempt every 3 s, for at most 150 s, until the teammate picks
// the number (`linked`: store the token, say "Linked to …") or the window
// closes. A linked device takes part through its capture uploads instead: an
// ingest reply's `linkPending` is followed the same way, with that upload's nonce.
//
// At most one hello or attempt runs at a time, and a `429` silences hellos for
// 60 s, so an end user shaking a release build repeatedly costs nothing.
//
// The session (endpoint, SDK key, host mode, transport, the config's
// `deviceLinking` block) is written from `start()`/`kill()` and config applies
// on any thread, under a lock. Attempts run on the main actor. Every session
// change bumps a generation, and a reply that lands after its session ended is
// dropped without touching the store.
//
// SECURITY: never log a token or a nonce.
import Foundation
#if canImport(UIKit)
import UIKit
#endif

@MainActor
final class DeviceLinkCoordinator {
    nonisolated static let shared = DeviceLinkCoordinator(store: .shared)

    static let checkInterval: TimeInterval = 3
    static let checkDeadline: TimeInterval = 150
    static let rateLimitSilence: TimeInterval = 60

    struct Seams {
        var showBanner: @MainActor (Int) -> Void
        var hideBanner: @MainActor () -> Void
        var showToast: @MainActor (String) -> Void
        var sleep: @Sendable (TimeInterval) async -> Void
        var now: @Sendable () -> TimeInterval
        var deviceInfo: @MainActor () -> DeviceLinkHelloRequest.Device
        var makeNonce: @Sendable () -> String
        /// The device became linked (true) or unlinked (false).
        var linkChanged: @MainActor (_ linked: Bool) -> Void

        static var live: Seams {
            Seams(
                showBanner: { number in
                    #if canImport(UIKit)
                    DeviceLinkBanner.show(number: number)
                    #endif
                },
                hideBanner: {
                    #if canImport(UIKit)
                    DeviceLinkBanner.hide()
                    #endif
                },
                showToast: { text in
                    #if canImport(UIKit)
                    QuickCaptureToast.show(text: text)
                    #endif
                },
                sleep: { seconds in try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000)) },
                now: { ProcessInfo.processInfo.systemUptime },
                deviceInfo: { DeviceLinkCoordinator.liveDeviceInfo() },
                makeNonce: { DeviceLinkNonce.make() },
                linkChanged: { linked in
                    #if canImport(UIKit)
                    QuickCapture.shared.setLinked(linked)
                    #endif
                    Everframe.shared.__refreshConfigForDeviceLink()
                }
            )
        }
    }

    private struct Session {
        let endpoint: URL
        let sdkKey: String
        let hostMode: QuickCaptureHostMode
        let transport: DeviceLinkTransport
        let generation: Int
    }

    var seams: Seams = .live

    // Guarded by `lock`; read and written from any thread.
    private let lock = NSLock()
    nonisolated(unsafe) private var store: DeviceLinkStore
    nonisolated(unsafe) private var session: Session?
    nonisolated(unsafe) private var remote: DeviceLinkingConfigWire?
    nonisolated(unsafe) private var generation = 0

    // Main actor.
    private var attempt: (id: Int, generation: Int, task: Task<Void, Never>)?
    private var attemptCounter = 0
    private var silencedUntil: TimeInterval = -.infinity
    private var bannerVisible = false

    nonisolated init(store: DeviceLinkStore) {
        self.store = store
    }

    convenience init(store: DeviceLinkStore, seams: Seams) {
        self.init(store: store)
        self.seams = seams
    }

    // MARK: Session (any thread)

    nonisolated func beginSession(
        endpoint: URL, sdkKey: String, hostMode: QuickCaptureHostMode,
        transport: DeviceLinkTransport, ifCurrent: () -> Bool = { true }
    ) {
        let newGeneration: Int
        lock.lock()
        guard ifCurrent() else { lock.unlock(); return }
        generation += 1
        newGeneration = generation
        session = Session(endpoint: endpoint, sdkKey: sdkKey, hostMode: hostMode,
                          transport: transport, generation: newGeneration)
        remote = nil
        lock.unlock()
        onMain { $0.endAttempt(olderThan: newGeneration) }
    }

    /// Applies the config's `deviceLinking` block. `link.status == .unlinked`
    /// clears the stored link, and `.linked` refreshes its owner, only while
    /// the stored token is the one that config request sent.
    nonisolated func publish(remote newRemote: DeviceLinkingConfigWire?, ifCurrent: () -> Bool = { true }) {
        var unlinked = false
        lock.lock()
        guard ifCurrent(), let session else { lock.unlock(); return }
        remote = newRemote
        if session.hostMode == .device, let link = newRemote?.link,
           let fingerprint = newRemote?.requestTokenFingerprint {
            switch link.status {
            case .unlinked:
                unlinked = store.clear(endpoint: session.endpoint, sdkKey: session.sdkKey, ifFingerprint: fingerprint)
            case .linked:
                if let owner = link.owner {
                    store.updateOwner(owner, endpoint: session.endpoint, sdkKey: session.sdkKey, ifFingerprint: fingerprint)
                }
            }
        }
        lock.unlock()
        if unlinked { onMain { $0.seams.linkChanged(false) } }
    }

    nonisolated func teardown(ifCurrent: () -> Bool = { true }) {
        let newGeneration: Int
        lock.lock()
        guard ifCurrent() else { lock.unlock(); return }
        generation += 1
        newGeneration = generation
        session = nil
        remote = nil
        lock.unlock()
        onMain { $0.endAttempt(olderThan: newGeneration) }
    }

    /// A real device whose app has device linking switched on.
    nonisolated var isLinkingEnabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return session?.hostMode == .device && remote?.enabled == true
    }

    /// The stored link for this session. Always nil outside `.device`: a
    /// simulator never reads a Keychain device token.
    nonisolated var currentLink: DeviceLink? {
        lock.lock(); defer { lock.unlock() }
        guard let session, session.hostMode == .device else { return nil }
        return store.link(endpoint: session.endpoint, sdkKey: session.sdkKey)
    }

    var isAttemptActive: Bool { attempt != nil }

    nonisolated var __sessionKeyForTesting: String? {
        lock.lock(); defer { lock.unlock() }
        return session?.sdkKey
    }

    nonisolated func __setStoreForTesting(_ newStore: DeviceLinkStore) {
        lock.lock(); defer { lock.unlock() }
        store = newStore
    }

    nonisolated private func snapshot() -> (session: Session, store: DeviceLinkStore)? {
        lock.lock(); defer { lock.unlock() }
        return session.map { ($0, store) }
    }

    nonisolated private func isCurrent(_ generation: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return session?.generation == generation
    }

    /// Runs `body` on the main actor: synchronously when already on the main
    /// thread (so a config apply sees its own unlink), otherwise on a hop.
    nonisolated private func onMain(_ body: @escaping @MainActor @Sendable (DeviceLinkCoordinator) -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { body(self) }
        } else {
            Task { @MainActor in body(self) }
        }
    }

    // MARK: Attempts (main actor)

    /// Sends a hello unless linking is off, the device is linked, an attempt
    /// is already running or a `429` silence is in effect.
    @discardableResult
    func sendHelloIfIdle() -> Task<Void, Never>? {
        guard isLinkingEnabled, currentLink == nil, attempt == nil, seams.now() >= silencedUntil,
              let (session, _) = snapshot() else { return nil }
        let nonce = seams.makeNonce()
        let device = seams.deviceInfo()
        return startAttempt(session: session) { coordinator, id in
            let result = await session.transport.hello(nonce: nonce, device: device)
            guard coordinator.isCurrent(session.generation), !Task.isCancelled else { return }
            switch result {
            case .rateLimited:
                coordinator.silencedUntil = coordinator.seams.now() + Self.rateLimitSilence
            case .failed, .reply(.none):
                break
            case let .reply(.pending(attemptId, number)):
                await coordinator.poll(session: session, attemptId: attemptId, number: number, nonce: nonce)
            }
        }
    }

    /// A capture upload's reply says a teammate is taking this device over.
    /// Checks the attempt with that upload's nonce. Ignored while an attempt runs.
    @discardableResult
    func followIngestPending(_ pending: DeviceLinkPending, nonce: String) -> Task<Void, Never>? {
        guard attempt == nil, let (session, _) = snapshot(), session.hostMode == .device else { return nil }
        return startAttempt(session: session) { coordinator, _ in
            await coordinator.poll(session: session, attemptId: pending.attemptId, number: pending.number, nonce: nonce)
        }
    }

    /// Ingest answered `403 device_unlinked` to a capture sent with
    /// `sentToken`. Clears the link only while that token is still stored.
    /// Shows no toast: quick capture shows "This device was unlinked".
    func handleDeviceUnlinked(sentToken: String) {
        guard let (session, store) = snapshot() else { return }
        if store.clear(endpoint: session.endpoint, sdkKey: session.sdkKey,
                       ifFingerprint: DeviceLinkToken.fingerprint(sentToken)) {
            seams.linkChanged(false)
        }
    }

    /// The outbox drain cleared a stored link (ingest answered `403
    /// device_unlinked` to a queued capture sent with that token). Drops this
    /// session's linked gate as `handleDeviceUnlinked` does, only when the
    /// cleared link was this session's (same origin and SDK key, `.device`)
    /// and no newer link has been stored for it since.
    func handleStoredLinkCleared(endpoint: URL, sdkKey: String) {
        guard let (session, store) = snapshot(), session.hostMode == .device,
              let cleared = DeviceLinkStore.account(endpoint: endpoint, sdkKey: sdkKey),
              cleared == DeviceLinkStore.account(endpoint: session.endpoint, sdkKey: session.sdkKey),
              store.link(endpoint: session.endpoint, sdkKey: session.sdkKey) == nil else { return }
        seams.linkChanged(false)
    }

    private func startAttempt(
        session: Session, _ body: @escaping @MainActor (DeviceLinkCoordinator, Int) async -> Void
    ) -> Task<Void, Never> {
        attemptCounter += 1
        let id = attemptCounter
        let task = Task { @MainActor [self] in
            await body(self, id)
            finishAttempt(id: id)
        }
        attempt = (id, session.generation, task)
        return task
    }

    private func finishAttempt(id: Int) {
        guard attempt?.id == id else { return }
        attempt = nil
        hideBannerOnce()
    }

    private func endAttempt(olderThan generation: Int) {
        guard let current = attempt, current.generation < generation else { return }
        current.task.cancel()
        attempt = nil
        hideBannerOnce()
    }

    private func hideBannerOnce() {
        guard bannerVisible else { return }
        bannerVisible = false
        seams.hideBanner()
    }

    private func poll(session: Session, attemptId: UUID, number: Int, nonce: String) async {
        bannerVisible = true
        seams.showBanner(number)
        let start = seams.now()
        while true {
            await seams.sleep(Self.checkInterval)
            guard isCurrent(session.generation), !Task.isCancelled else { return }
            let result = await session.transport.check(attemptId: attemptId, nonce: nonce)
            guard isCurrent(session.generation), !Task.isCancelled else { return }
            switch result {
            case .reply(.pending), .retry:
                break
            case .reply(.expired), .stop:
                return
            case let .reply(.linked(token, owner)):
                guard let (current, store) = snapshot(), current.generation == session.generation else { return }
                store.save(DeviceLink(token: token, owner: owner), endpoint: current.endpoint, sdkKey: current.sdkKey)
                hideBannerOnce()
                seams.showToast(owner.linkedToastText)
                seams.linkChanged(true)
                return
            }
            if seams.now() - start >= Self.checkDeadline { return }
        }
    }

    // MARK: Device info

    private static func liveDeviceInfo() -> DeviceLinkHelloRequest.Device {
        let appVersion = AppRelease.current(debugBuild: nil).version
        #if canImport(UIKit)
        let device = UIDevice.current
        let formFactor: String
        switch device.userInterfaceIdiom {
        case .pad: formFactor = "tablet"
        case .tv: formFactor = "tv"
        default: formFactor = "phone"
        }
        return DeviceLinkHelloRequest.Device(
            model: VitalsDims.machineIdentifier(), os: device.systemName, osVersion: device.systemVersion,
            appVersion: appVersion.isEmpty ? "unknown" : appVersion,
            sdk: "ios/\(Everframe.SDK_VERSION)", formFactor: formFactor)
        #else
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return DeviceLinkHelloRequest.Device(
            model: VitalsDims.machineIdentifier(), os: "macOS",
            osVersion: "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)",
            appVersion: appVersion.isEmpty ? "unknown" : appVersion,
            sdk: "ios/\(Everframe.SDK_VERSION)", formFactor: "phone")
        #endif
    }
}
