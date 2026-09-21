// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Thread-safe local AND dashboard gate shared by UIKit event delivery and config refreshes.
final class ShakeToReportGate: @unchecked Sendable {
    private let lock = NSLock()
    private var localEnabled: Bool
    private var remoteEnabled: Bool?
    private var inFlight = false

    init(localEnabled: Bool) {
        self.localEnabled = localEnabled
    }

    func setLocalEnabled(_ enabled: Bool) {
        lock.lock(); defer { lock.unlock() }
        localEnabled = enabled
    }

    func setRemoteEnabled(_ enabled: Bool?) {
        lock.lock(); defer { lock.unlock() }
        remoteEnabled = enabled
    }

    func tryBegin(presenting: Bool, applicationActive: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard localEnabled, remoteEnabled == true, applicationActive, !presenting, !inFlight else {
            return false
        }
        inFlight = true
        return true
    }

    func complete() {
        lock.lock(); defer { lock.unlock() }
        inFlight = false
    }
}

final class ShakeToReportTrigger: @unchecked Sendable {
    static let shared = ShakeToReportTrigger()
    private let stateLock = NSLock()
    private var gate = ShakeToReportGate(localEnabled: false)

    private init() {}

    func beginSession(localEnabled: Bool, ifCurrent: () -> Bool) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate = ShakeToReportGate(localEnabled: localEnabled)
    }

    func publish(remoteEnabled: Bool?, ifCurrent: () -> Bool) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate.setRemoteEnabled(remoteEnabled)
    }

    func teardown(ifCurrent: () -> Bool) {
        stateLock.lock(); defer { stateLock.unlock() }
        guard ifCurrent() else { return }
        gate = ShakeToReportGate(localEnabled: false)
    }

    #if os(iOS) && !targetEnvironment(macCatalyst)
    @MainActor
    func handleShake() {
        stateLock.lock()
        let currentGate = gate
        stateLock.unlock()
        guard currentGate.tryBegin(
            presenting: TraceItX.shared.report.isPresenting,
            applicationActive: UIApplication.shared.applicationState == .active
        ) else { return }

        Task { @MainActor in
            defer { currentGate.complete() }
            _ = try? await TraceItX.shared.report.open()
        }
    }
    #endif
}

#if os(iOS) && !targetEnvironment(macCatalyst)
import UIKit
#endif
