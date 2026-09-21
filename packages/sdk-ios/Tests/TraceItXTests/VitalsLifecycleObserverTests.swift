// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// UIKit-gated: runs ONLY in swift.yml's lifecycle-tests-iOS job (TESTING.md).
//
// Codex round-1, O2 — `.github/workflows/swift.yml` names this suite as the guard for the
// `beginBackgroundTask`/`endBackgroundTask` wrap around pause+flush, and until now it did not
// test it at all: deleting BOTH calls left every case green while iOS silently dropped the last
// chunk on every backgrounding, and deleting only the end leaked an unbalanced task, which iOS
// terminates the app for. The two calls are injected here the way `isBackgrounded` already was,
// so the counts are asserted across all three ways a background window can close.
#if canImport(UIKit)
import Testing
import Foundation
import UIKit
@testable import TraceItXKit

@MainActor
@Suite(.serialized)
struct VitalsLifecycleObserverTests {
    /// Records the two UIApplication calls the real observer makes, and keeps the expiration
    /// handler UIKit would otherwise own so the OS-expiry path can be driven too.
    private final class TaskSpy: @unchecked Sendable {
        let begins = Locked(0), ends = Locked(0)
        let expire = Locked<(@Sendable () -> Void)?>(nil)
        private let ids = Locked(0)
        var beginTask: @Sendable (String, @escaping @Sendable () -> Void) -> UIBackgroundTaskIdentifier {
            { [self] _, onExpire in
                begins.mutate { $0 += 1 }
                expire.mutate { $0 = onExpire }
                var next = 0
                ids.mutate { $0 += 1; next = $0 }
                return UIBackgroundTaskIdentifier(rawValue: next)
            }
        }
        var endTask: @Sendable (UIBackgroundTaskIdentifier) -> Void { { [self] _ in ends.mutate { $0 += 1 } } }
    }

    private func observer(_ spy: TaskSpy, center: NotificationCenter, backgrounded: Bool = false,
                          capMs: Int64 = VitalsLifecycleObserver.backgroundTaskCapMs,
                          fg: @escaping @Sendable () -> Void = {}, bg: @escaping @Sendable () -> Void = {}) -> VitalsLifecycleObserver {
        VitalsLifecycleObserver(onForeground: fg, onBackground: bg, notificationCenter: center,
                                isBackgrounded: { backgrounded }, capMs: capMs,
                                beginTask: spy.beginTask, endTask: spy.endTask)
    }
    /// Polls on the main actor, which also lets the observer's `DispatchQueue.main` work run.
    private func waitFor(_ predicate: () -> Bool, seconds: Double = 5) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return predicate()
    }

    @Test func backgroundPausesAndFlushesForegroundResumes() async {
        let nc = NotificationCenter()
        let fg = Locked(0), bg = Locked(0)
        let spy = TaskSpy()
        let o = observer(spy, center: nc, fg: { fg.mutate { $0 += 1 } }, bg: { bg.mutate { $0 += 1 } })
        o.install()
        await Task.yield()
        nc.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        #expect(bg.value == 1)
        // The flush runs INSIDE a background task, or iOS suspends the process before the last
        // chunk leaves — there is no beacon path on iOS.
        #expect(spy.begins.value == 1)
        #expect(spy.ends.value == 0)
        nc.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        #expect(fg.value == 1)
        #expect(spy.ends.value == 1)          // …and it is ENDED, or iOS terminates the app
        o.uninstall()
        await Task.yield()
        nc.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        #expect(bg.value == 1)
        #expect(spy.begins.value == 1)
    }

    @Test func aBackgroundWindowThatReachesTheCapEndsItsTask() async {
        let nc = NotificationCenter()
        let spy = TaskSpy()
        let o = observer(spy, center: nc, capMs: 20)
        o.install()
        await Task.yield()
        nc.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        #expect(spy.begins.value == 1)
        #expect(await waitFor { spy.ends.value == 1 }, "the cap must end the task even with no foreground")
        // A second background window takes a fresh task rather than reusing the expired one.
        nc.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        #expect(spy.begins.value == 2)
        o.uninstall()
        await Task.yield()
        #expect(await waitFor { spy.ends.value == 2 })
    }

    @Test func uninstallWhileBackgroundedEndsTheOutstandingTask() async {
        let nc = NotificationCenter()
        let spy = TaskSpy()
        let o = observer(spy, center: nc)
        o.install()
        await Task.yield()
        nc.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        #expect(spy.begins.value == 1)
        o.uninstall()
        await Task.yield()
        #expect(await waitFor { spy.ends.value == 1 }, "an uninstall must not leave an unbalanced background task")
        // Idempotent: the identifier is cleared, so nothing is ended twice.
        o.uninstall()
        await Task.yield()
        #expect(spy.ends.value == 1)
    }

    @Test func theOSExpirationHandlerEndsTheTask() async {
        let nc = NotificationCenter()
        let spy = TaskSpy()
        let o = observer(spy, center: nc)
        o.install()
        await Task.yield()
        nc.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        #expect(spy.begins.value == 1)
        spy.expire.value?()                    // UIKit reclaiming the task
        #expect(spy.ends.value == 1)
        nc.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        #expect(spy.ends.value == 1)           // …and the foreground does not end it twice
        o.uninstall()
    }

    @Test func installingWhileAlreadyBackgroundedTakesTheBackgroundPathImmediately() async {
        let nc = NotificationCenter()
        let bg = Locked(0)
        let spy = TaskSpy()
        let o = observer(spy, center: nc, backgrounded: true, bg: { bg.mutate { $0 += 1 } })
        o.install()
        await Task.yield()
        #expect(bg.value == 1)
        #expect(spy.begins.value == 1)
        o.uninstall()
        await Task.yield()
        #expect(await waitFor { spy.ends.value == 1 })
    }

    @Test func doubleInstallAndUnbalancedUninstallAreNoOps() async {
        let nc = NotificationCenter()
        let bg = Locked(0)
        let spy = TaskSpy()
        let o = observer(spy, center: nc, bg: { bg.mutate { $0 += 1 } })
        o.uninstall(); o.install(); o.install()
        await Task.yield()
        nc.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        #expect(bg.value == 1)
        #expect(spy.begins.value == 1)         // one observer registration, one task
        o.uninstall(); o.uninstall()
        await Task.yield()
        #expect(await waitFor { spy.ends.value == 1 })
    }
}
#endif
