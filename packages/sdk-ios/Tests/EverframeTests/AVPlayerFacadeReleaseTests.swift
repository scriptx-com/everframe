// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The release sentinel against a REAL AVPlayer. `FakeFacade` models the seam,
// not the objc_setAssociatedObject machinery underneath it, so nothing in
// AVPlayerIntegrationTests can see these two failure shapes:
//   - a shared association key, where a second facade on one player clobbers
//     the first and reports a release for a player that is still alive;
//   - a strong reference to the sentinel, which keeps it alive past the
//     player's dealloc so the release is never reported AT ALL.
// AVFoundation is available on macOS, so both run on the host.
import AVFoundation
import XCTest
@testable import EverframeKit

/// An item whose state is already settled when it is handed to `replaceCurrentItem` — the
/// shape W5-I6 is about. AVFoundation cannot be made to produce one on a host with no media, so
/// the three properties the seed reads are overridden.
final class PreparedItem: AVPlayerItem {
    override var status: AVPlayerItem.Status { .readyToPlay }
    override var presentationSize: CGSize { CGSize(width: 1920, height: 1080) }
    override var loadedTimeRanges: [NSValue] {
        [NSValue(timeRange: CMTimeRange(start: .zero, duration: CMTime(seconds: 30, preferredTimescale: 600)))]
    }
}

final class AVPlayerFacadeReleaseTests: XCTestCase {
    func testTwoFacadesOnOnePlayerDoNotClobberEachOthersSentinel() {
        let player = AVPlayer()
        let a = AVPlayerFacade(player: player), b = AVPlayerFacade(player: player)
        var firedA = 0, firedB = 0
        XCTAssertTrue(a.observeRelease { firedA += 1 })
        XCTAssertTrue(b.observeRelease { firedB += 1 })
        XCTAssertEqual(firedA, 0, "installing B's sentinel must not deallocate A's and report a bogus release")
        XCTAssertEqual(firedB, 0)
    }

    func testUnobserveReleaseDisarmsWhileARealReleaseStillFiresForTheFacadeThatKeptItsSentinel() {
        let firedA = Locked(0), firedB = Locked(0)
        // Both facades outlive the player, exactly as production does: the
        // integration owns the facade and the registry owns the integration.
        var a: AVPlayerFacade!
        var b: AVPlayerFacade!
        autoreleasepool {
            var player: AVPlayer? = AVPlayer()
            a = AVPlayerFacade(player: player!)
            b = AVPlayerFacade(player: player!)
            _ = a.observeRelease { firedA.mutate { $0 += 1 } }
            _ = b.observeRelease { firedB.mutate { $0 += 1 } }
            a.unobserveRelease()
            a.unobserveRelease()   // idempotent
            XCTAssertEqual(firedA.value, 0, "dropping the association must not fire the sentinel — the player is alive")
            player = nil
        }
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { !b.isAlive && firedB.value == 1 },
                      "real AVPlayer teardown and its kept sentinel callback must complete")
        XCTAssertFalse(b.isAlive, "the player really did deallocate")
        XCTAssertEqual(firedB.value, 1, "the facade that kept its sentinel is told about the real release")
        XCTAssertEqual(firedA.value, 0, "the one that dropped it is not")
        b.unobserveRelease()       // safe after the sentinel has already gone
        XCTAssertEqual(firedB.value, 1)
    }

    /// Codex round-1, #8. A `currentItem` KVO callback that entered before `unobserve()` and
    /// resumes after it used to rebuild this facade's item observers unconditionally — fresh
    /// KVO and notification registrations on an attachment that is over, which the
    /// integration's later detach never removes because it is no longer attached. The same
    /// check covers the second direction: a callback from an EARLIER attachment must not
    /// mutate a later one.
    func testAnItemChangeCallbackFromADeadOrEarlierAttachmentReinstallsNothing() {
        let player = AVPlayer()
        let facade = AVPlayerFacade(player: player)
        let item = AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent.mp4"))

        XCTAssertTrue(facade.observe(PlayerFacadeEvents()))
        let staleGeneration = facade.observationGenerationForTesting
        facade.unobserve()
        XCTAssertEqual(facade.installedObserverCountForTesting, 0)

        facade.__replayItemDidChangeForTesting(item, gen: staleGeneration)
        XCTAssertEqual(facade.installedObserverCountForTesting, 0, "a dead attachment must not rebuild observers")

        XCTAssertTrue(facade.observe(PlayerFacadeEvents()))
        let live = facade.installedObserverCountForTesting
        facade.__replayItemDidChangeForTesting(item, gen: staleGeneration)
        XCTAssertEqual(facade.installedObserverCountForTesting, live, "…nor may it mutate the attachment that replaced it")
        facade.unobserve()
    }

    /// Codex round-4, #1. WITHIN one attachment the observation generation cannot tell a stalled
    /// `currentItem` callback from a current one: A reads `p.currentItem` as A and stalls before
    /// taking the facade lock, B installs B's observers and delivers its change, and A then
    /// rebuilt the observers for A under a NEWER item generation — after which the integration
    /// accepted A as current and every callback for the item actually playing was dropped.
    /// Round-3's test covers deliveries overtaking AFTER `observeItem`; this one overtakes it.
    func testAnItemChangeOvertakenWithinTheSameAttachmentRebuildsNothing() {
        let a = AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent-a.mp4"))
        let b = AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent-b.mp4"))
        let player = AVPlayer(playerItem: a)
        let facade = AVPlayerFacade(player: player)

        let changes = Locked<[String]>([])
        let events = PlayerFacadeEvents()
        events.onItemChanged = { item, _, _, _ in changes.mutate { $0.append(item?.url?.lastPathComponent ?? "nil") } }
        XCTAssertTrue(facade.observe(events))
        let attachment = facade.observationGenerationForTesting

        player.replaceCurrentItem(with: b)
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { changes.value.contains("nonexistent-b.mp4") },
                      "precondition: B's own item change was delivered")
        let afterB = facade.currentItemGeneration
        let deliveredB = changes.value

        // A's callback: captured before B's, resumed after it. Same attachment, same observation
        // generation, an item that is no longer the player's current one.
        facade.__replayItemDidChangeForTesting(a, gen: attachment)

        XCTAssertEqual(facade.currentItemGeneration, afterB,
                       "a stale item change must not rebuild the observers under a newer generation")
        XCTAssertEqual(changes.value, deliveredB, "…nor announce the previous item as the current one")
        facade.unobserve()
    }

    /// Codex round-5, W5-I6 — a replacement item's ALREADY-SETTLED state must reach the
    /// integration. The item observations are registered with `options: [.new]`, so nothing
    /// fires until a value CHANGES; attachment does not care because `attach()` seeds itself
    /// from `readState()`, but a replacement had no equivalent. `onItem` clears the resolution
    /// and the loaded ranges (round-4, W4-I5), so a paused, fully buffered replacement reported
    /// zero buffer ahead and no dimensions for as long as it stayed unchanged, and its
    /// established readiness was never reported at all.
    func testAnAlreadyPreparedReplacementItemHasItsSettledStateDelivered() {
        let player = AVPlayer(playerItem: AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent-a.mp4")))
        let facade = AVPlayerFacade(player: player)
        let log = Locked<[String]>([])
        let events = PlayerFacadeEvents()
        events.onItemChanged = { item, _, _, gen in log.mutate { $0.append("item:\(item?.url?.lastPathComponent ?? "nil"):\(gen)") } }
        events.onItemStatusChanged = { s, gen in log.mutate { $0.append("status:\(s == .readyToPlay ? "ready" : "other"):\(gen.map(String.init) ?? "-")") } }
        events.onPresentationSizeChanged = { w, h, gen in log.mutate { $0.append("size:\(w)x\(h):\(gen)") } }
        events.onLoadedRangesChanged = { r, gen in log.mutate { $0.append("ranges:\(r.count):\(r.first?.end ?? -1):\(gen)") } }
        XCTAssertTrue(facade.observe(events))

        let prepared = PreparedItem(url: URL(fileURLWithPath: "/nonexistent-b.mp4"))
        player.replaceCurrentItem(with: prepared)
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { log.value.contains { $0.hasPrefix("item:nonexistent-b.mp4") } },
                      "precondition: the replacement's own item change was delivered")
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { log.value.count >= 4 }, "the settled state follows it: \(log.value)")

        let gen = facade.currentItemGeneration
        XCTAssertEqual(log.value.suffix(4), ["item:nonexistent-b.mp4:\(gen)", "status:ready:\(gen)", "size:1920x1080:\(gen)", "ranges:1:30000:\(gen)"],
                       "seeded AFTER the item change, and under that change's own generation")
        facade.unobserve()
    }

    /// An ordinary empty replacement says nothing: no status, no size, no ranges, so the
    /// callbacks that follow are exactly the ones AVFoundation delivers.
    func testAnUnpreparedReplacementItemSeedsNothing() {
        let player = AVPlayer(playerItem: AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent-a.mp4")))
        let facade = AVPlayerFacade(player: player)
        let log = Locked<[String]>([])
        let events = PlayerFacadeEvents()
        events.onItemChanged = { item, _, _, _ in log.mutate { $0.append("item:\(item?.url?.lastPathComponent ?? "nil")") } }
        events.onItemStatusChanged = { _, _ in log.mutate { $0.append("status") } }
        events.onPresentationSizeChanged = { _, _, _ in log.mutate { $0.append("size") } }
        events.onLoadedRangesChanged = { _, _ in log.mutate { $0.append("ranges") } }
        XCTAssertTrue(facade.observe(events))

        player.replaceCurrentItem(with: AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent-b.mp4")))
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { log.value.contains("item:nonexistent-b.mp4") })
        XCTAssertEqual(log.value.filter { $0 == "size" || $0 == "ranges" }, [], "nothing to say, nothing said: \(log.value)")
        facade.unobserve()
    }

    /// Codex round-7, W7-I1 — the periodic tick reports the position of the item the facade is
    /// REGISTERED for, together with that item's generation, instead of the `CMTime` AVFoundation
    /// captured whenever it scheduled the block. This pins the binding in both directions: the
    /// generation follows the registered item, and a player with no item reports no tick at all
    /// (rather than the previous item's generation over an empty player's position).
    func testThePeriodicTickIsBoundToTheRegisteredItemAndSilentWithoutOne() {
        let player = AVPlayer(playerItem: AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent-a.mp4")))
        let facade = AVPlayerFacade(player: player)
        let events = PlayerFacadeEvents()
        let changes = Locked(0)
        events.onItemChanged = { _, _, _, _ in changes.mutate { $0 += 1 } }
        XCTAssertTrue(facade.observe(events))
        XCTAssertEqual(facade.__readTickForTesting()?.gen, facade.currentItemGeneration, "the registered item ticks under its own generation")

        player.replaceCurrentItem(with: AVPlayerItem(url: URL(fileURLWithPath: "/nonexistent-b.mp4")))
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { changes.value >= 1 })
        let afterReplace = facade.currentItemGeneration
        XCTAssertEqual(facade.__readTickForTesting()?.gen, afterReplace, "and the replacement ticks under the replacement's")

        // The player still HAS item B here: what stops the tick is that this facade no longer
        // has a registration for it, which is the same check that stops a tick landing in the
        // window between `currentItem` changing and the facade registering for the new item.
        facade.unobserve()
        XCTAssertNil(facade.__readTickForTesting(), "no registration, no tick — the item is still there")

        XCTAssertTrue(facade.observe(events))
        XCTAssertNotNil(facade.__readTickForTesting(), "and re-observing restores it")
        player.replaceCurrentItem(with: nil)
        XCTAssertTrue(AsyncTestHelpersSync.waitFor { facade.__readTickForTesting() == nil },
                      "an empty player has no position to report under any generation")
        facade.unobserve()
    }

    /// Round-1, O7 — the facade reads `asset` through KVC (the typed property is
    /// `@MainActor`-isolated and these callbacks are not on the main actor). Nothing else pins
    /// that key: an AVFoundation rename would silently degrade every `source_change` to unknown.
    func testTheKVCAssetKeyStillReturnsTheURLAsset() {
        let url = URL(fileURLWithPath: "/nonexistent.mp4")
        let item = AVPlayerItem(url: url)
        let asset = item.value(forKey: "asset") as? AVURLAsset
        XCTAssertNotNil(asset, "AVPlayerItem.value(forKey: \"asset\") must still answer an AVURLAsset")
        XCTAssertEqual(asset?.url, url)
    }
}
