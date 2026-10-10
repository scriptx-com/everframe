// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import CryptoKit
@testable import EverframeKit

final class AppleDiagnosticConsentTests: XCTestCase {
    private var root: URL!
    private let key = Data(repeating: 0x53, count: 32)
    private let t = Date(timeIntervalSince1970: 1_800_000_000)
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func store() throws -> AppleDiagnosticStore {
        let key = key; let s = try AppleDiagnosticStore(root: root, keyProvider: { key })
        if s.needsOutboxErase { try s.finishErasure() }; try s.activate(); return s
    }
    private func context(key: String = "sdk-A", endpoint: String = "https://example.invalid/api/ingest", bundle: String = "dev.example.host",
                         version: String = "1.0", build: String = "42", release: String = "release-A", pattern: String = "secret", changedDevice: Bool = false) throws -> AppleDiagnosticContext {
        let config = EverframeConfig(appId: key, release: release, redaction: .init(customPatterns: [try NSRegularExpression(pattern: pattern)]))
        let device = DeviceMetadata(model: changedDevice ? "iPad" : "iPhone", osName: "iOS", osVersion: changedDevice ? "19.0" : "18.0",
            locale: changedDevice ? "lt_LT" : "en_US", timezone: changedDevice ? "Europe/Vilnius" : "UTC", appVersion: version,
            appBuild: build, bundleIdentifier: bundle, screenWidth: changedDevice ? 800 : 400, screenHeight: changedDevice ? 400 : 800, pixelRatio: changedDevice ? 3 : 2)
        return .init(frozen: try NativeCrashStartupContext.make(config: config, user: nil, device: device, endpoint: endpoint), applicationVersion: version, applicationBuild: build)
    }
    private func candidate(_ begin: Date, _ end: Date) -> AppleDiagnosticCandidate {
        .init(kind: "hang_batch", begin: begin, end: end, applicationVersion: "1.0", applicationBuild: "42", osVersion: "iOS 19.0",
              hangs: [.init(durationMs: 2000, stack: .init(status: "unavailable", truncated: false, frames: []))], exits: [], truncated: false)
    }
    func testDeviceChangesPreserveOwnershipAndFrozenGrantAcrossRestart() throws {
        let a = try context(), b = try context(changedDevice: true)
        XCTAssertEqual(try a.ownerDigest(), try b.ownerDigest())
        let first = try XCTUnwrap(store().authorize(context: a, scope: .installation, now: t))
        let next = try store(); let renewed = try XCTUnwrap(next.authorize(context: b, scope: .installation, now: t.addingTimeInterval(86400)))
        XCTAssertEqual(renewed.id, first.id); XCTAssertEqual(renewed.begin, t)
        XCTAssertEqual(renewed.authorizedThrough, t.addingTimeInterval(8 * 86400))
        XCTAssertEqual(renewed.context.frozen.envelopeTemplate, a.frozen.envelopeTemplate)
        let found = try XCTUnwrap(next.grant(for: candidate(t, t.addingTimeInterval(86400)), context: b, now: t.addingTimeInterval(86400)))
        XCTAssertEqual(found.id, first.id)
    }
    func testEveryOwnerFieldChangesDigestAndInvalidatesHistoryWithoutExhaustingCapacity() throws {
        let a = try context(), digest = try a.ownerDigest(), s = try store()
        let changed = try [context(key: "sdk-B"), context(endpoint: "https://other.invalid"), context(bundle: "other.bundle"),
            context(version: "2.0"), context(build: "43"), context(release: "other-release"), context(pattern: "other-secret")]
        for c in changed { XCTAssertNotEqual(try c.ownerDigest(), digest) }
        for i in 0..<9 {
            let c = try context(key: "sdk-\(i)")
            XCTAssertNotNil(try s.authorize(context: c, scope: .installation, now: t.addingTimeInterval(Double(i))))
        }
        XCTAssertNil(try s.grant(for: candidate(t, t), context: try context(key: "sdk-0"), now: t.addingTimeInterval(10)))
    }
    func testClosedIntervalsRemainAdmissibleButCannotBridgeBoundariesAndOldestClosedIsEvicted() throws {
        let c = try context(), s = try store()
        let first = try XCTUnwrap(s.authorize(context: c, scope: .installation, now: t))
        for i in 1...8 {
            let boundary = t.addingTimeInterval(Double(i) * 10)
            try s.closeConsent(at: boundary, unlessOwner: nil)
            let next = try XCTUnwrap(s.authorize(context: c, scope: .installation, now: boundary.addingTimeInterval(1)))
            XCTAssertNotEqual(next.id, first.id)
        }
        XCTAssertNil(try s.grant(for: candidate(t, t), context: c, now: t.addingTimeInterval(90)))
        XCTAssertNotNil(try s.grant(for: candidate(t.addingTimeInterval(11), t.addingTimeInterval(20)), context: c, now: t.addingTimeInterval(90)))
        XCTAssertNil(try s.grant(for: candidate(t.addingTimeInterval(19), t.addingTimeInterval(22)), context: c, now: t.addingTimeInterval(90)))
    }
    func testMatchingStartupDoesNotWriteButDifferentOwnerClosesAtItsStart() throws {
        let c = try context(), s = try store(); _ = try s.authorize(context: c, scope: .installation, now: t)
        let key = key
        let noWrites = try AppleDiagnosticStore(root: root, keyProvider: { key }, beforeCommit: { XCTFail("Matching startup must not rewrite state") })
        try noWrites.closeConsent(at: t.addingTimeInterval(10), unlessOwner: c.ownerDigest())
        try s.closeConsent(at: t.addingTimeInterval(10), unlessOwner: context(key: "sdk-B").ownerDigest())
        XCTAssertNotNil(try s.grant(for: candidate(t, t.addingTimeInterval(9)), context: c, now: t.addingTimeInterval(20)))
        XCTAssertNil(try s.grant(for: candidate(t.addingTimeInterval(11), t.addingTimeInterval(12)), context: c, now: t.addingTimeInterval(20)))
    }
    func testWholePeriodWarmupDelayExpiryAndRollbackBoundaries() throws {
        let c = try context(), s = try store(); _ = try s.authorize(context: c, scope: .installation, now: t)
        let day = t.addingTimeInterval(86400)
        XCTAssertNil(try s.grant(for: candidate(t.addingTimeInterval(-0.001), day.addingTimeInterval(-0.001)), context: c, now: day))
        XCTAssertNotNil(try s.grant(for: candidate(t, day), context: c, now: day))
        XCTAssertNil(try s.grant(for: candidate(t, day.addingTimeInterval(0.001)), context: c, now: day.addingTimeInterval(1)))
        XCTAssertNil(try s.grant(for: candidate(day, day.addingTimeInterval(2)), context: c, now: day.addingTimeInterval(1)))
        XCTAssertNil(try s.grant(for: candidate(t, t), context: c, now: t.addingTimeInterval(7 * 86400 + 0.001)))
        let newTime = t.addingTimeInterval(8 * 86400)
        let newer = try XCTUnwrap(s.authorize(context: c, scope: .installation, now: newTime)); XCTAssertEqual(newer.begin, newTime)
        XCTAssertNil(try s.grant(for: candidate(newTime, newTime), context: c, now: newTime.addingTimeInterval(-1)))
        XCTAssertNil(try s.grant(for: candidate(newTime, newTime), context: c, now: newTime.addingTimeInterval(1)))
    }
    func testProcessScopeClosesPersistentGrantAndRevocationErasesIt() throws {
        let c = try context(), s = try store(); let first = try XCTUnwrap(s.authorize(context: c, scope: .installation, now: t))
        XCTAssertNil(try s.authorize(context: c, scope: .currentProcess, now: t.addingTimeInterval(10)))
        let second = try XCTUnwrap(s.authorize(context: c, scope: .installation, now: t.addingTimeInterval(20)))
        XCTAssertNotEqual(first.id, second.id); XCTAssertEqual(second.begin, t.addingTimeInterval(20))
        try s.revoke(); try s.finishErasure(); try s.activate()
        XCTAssertNil(try s.grant(for: candidate(t, t), context: c, now: t.addingTimeInterval(30)))
    }
    func testSchemaOneMigrationPreservesReceiptsAndNeverBackfillsConsent() throws {
        let s = try store(), id = UUID()
        let entry = OutboxEntry(reportId: id, createdAt: t, envelopeBytes: Data("frozen".utf8), idempotencyKey: "stable", attachmentRefs: [], sdkKey: "sdk-A", endpoint: "https://example.invalid")
        try s.stage(entry, hash: String(repeating: "a", count: 64))
        let path = root.appendingPathComponent("state"), magic = Data("EFAPPL01".utf8)
        let encrypted = try Data(contentsOf: path)
        let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: encrypted.dropFirst(magic.count)), using: SymmetricKey(data: key), authenticating: magic)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: plain) as? [String: Any]); object["version"] = 1; object.removeValue(forKey: "grants")
        let box = try AES.GCM.seal(JSONSerialization.data(withJSONObject: object), using: SymmetricKey(data: key), authenticating: magic)
        try (magic + XCTUnwrap(box.combined)).write(to: path)
        let migrated = try store(); XCTAssertEqual(migrated.pending, [entry])
        XCTAssertNil(try migrated.grant(for: candidate(t, t), context: context(), now: t.addingTimeInterval(10)))
        let grant = try XCTUnwrap(migrated.authorize(context: context(), scope: .installation, now: t.addingTimeInterval(10)))
        XCTAssertEqual(grant.begin, t.addingTimeInterval(10)); XCTAssertEqual(try store().pending, [entry])
    }
    func testFailedAuthorizationDoesNotPublishOrEvictExistingReceipts() throws {
        let s = try store(), c = try context()
        for n in 0..<32 {
            let e = OutboxEntry(reportId: UUID(), createdAt: t, envelopeBytes: Data("receipt".utf8), idempotencyKey: "\(n)", attachmentRefs: [], sdkKey: "sdk-A", endpoint: "https://example.invalid")
            try s.stage(e, hash: String(format: "%064x", n))
        }
        let before = s.pending, key = key
        let failing = try AppleDiagnosticStore(root: root, keyProvider: { key }, beforeCommit: { throw CocoaError(.fileWriteNoPermission) })
        XCTAssertThrowsError(try failing.authorize(context: c, scope: .installation, now: t))
        let reopened = try store(); XCTAssertEqual(reopened.pending, before)
        XCTAssertNil(try reopened.grant(for: candidate(t, t), context: c, now: t))
        XCTAssertNotNil(try reopened.authorize(context: c, scope: .installation, now: t)); XCTAssertEqual(reopened.pending, before)
    }
    func testStartedBundleProjectionMatchesRealContextWithoutDeviceFacts() throws {
        let bundleURL = root.appendingPathComponent("Host.bundle")
        try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: false)
        let info = ["CFBundleIdentifier": "dev.example.host", "CFBundleShortVersionString": "1.0", "CFBundleVersion": "42", "CFBundlePackageType": "BNDL"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: bundleURL.appendingPathComponent("Info.plist"))
        let bundle = try XCTUnwrap(Bundle(url: bundleURL))
        let config = EverframeConfig(appId: "sdk-A", release: "release-A", redaction: .init(customPatterns: [try NSRegularExpression(pattern: "secret")]))
        XCTAssertEqual(try AppleDiagnosticContext.ownerDigest(config: config, endpoint: "https://example.invalid/api/ingest", bundle: bundle), try context().ownerDigest())
    }
    func testByteCapacityFailurePreservesReceiptAndDoesNotEstablishGrant() throws {
        let s = try store()
        let entry = OutboxEntry(reportId: UUID(), createdAt: t, envelopeBytes: Data(repeating: 1, count: 3_144_000),
            idempotencyKey: "large", attachmentRefs: [], sdkKey: "sdk-A", endpoint: "https://example.invalid")
        try s.stage(entry, hash: String(repeating: "a", count: 64))
        XCTAssertThrowsError(try s.authorize(context: context(), scope: .installation, now: t))
        let reopened = try store(); XCTAssertEqual(reopened.pending, [entry])
        XCTAssertNil(try reopened.grant(for: candidate(t, t), context: context(), now: t))
    }

}
