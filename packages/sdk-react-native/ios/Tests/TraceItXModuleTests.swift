// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// XCTest coverage for the iOS half of the React Native TurboModule bridge.
//
// Goals:
//   1. `captureNow` callback returns a dictionary with exactly the 4 documented
//      keys (`screenshot`, `uiTree`, `metadata`, `sensitiveRects`).
//   2. PNG bytes NEVER cross the bridge — `screenshot` is a `file://` URI String,
//      not Data / NSData. (T-06-02-02 mitigation enforced.)
//   3. `submit` enqueues an entry into the on-disk JSONL outbox.
//
// These tests instantiate `TraceItXBridge` directly (Swift static-method facade
// over the sdk-ios public API). They run via the podspec `test_spec 'Tests'`
// block once the sample-app workspace integrates the pod (Plan 06-06). Locally,
// they can be exercised against a thin UIKit host (an XCTest UIWindow + a
// throw-away rootViewController) — see `makeTestWindow()` below.
#if canImport(UIKit) && canImport(XCTest)
import XCTest
import UIKit
@testable import TraceItX_ReactNative

final class TraceItXModuleTests: XCTestCase {

    // MARK: - Test helpers

    /// Build a host-visible UIWindow so capture / accessibility / sensitive walks
    /// have something concrete to operate on. Without a key window,
    /// `ScreenshotCapture.activeKeyWindow()` returns nil and the bridge would
    /// degrade. The window is sized and made key+visible for the duration of
    /// the test; tearDown reverses it.
    private var hostWindow: UIWindow?

    override func setUp() {
        super.setUp()
        // Build a 200x200 host window. The XCTest harness on iOS exposes a
        // foreground-active UIWindowScene; we attach the window to it.
        if let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) {
            let w = UIWindow(windowScene: scene)
            w.frame = CGRect(x: 0, y: 0, width: 200, height: 200)
            let vc = UIViewController()
            vc.view.backgroundColor = .systemBackground
            w.rootViewController = vc
            w.windowLevel = .normal
            w.makeKeyAndVisible()
            hostWindow = w
        }
    }

    override func tearDown() {
        hostWindow?.isHidden = true
        hostWindow = nil
        super.tearDown()
    }

    // MARK: - captureNow callback shape

    func testCaptureNowDictShape() {
        let exp = expectation(description: "captureNow completion")
        DispatchQueue.main.async {
            TraceItXBridge.captureNow { dict, err in
                XCTAssertNil(err, "captureNow should not error in a key-window context")
                guard let dict = dict else {
                    XCTFail("captureNow returned nil dict")
                    exp.fulfill()
                    return
                }
                let keys = Set(dict.allKeys.compactMap { $0 as? String })
                let expected: Set<String> = ["screenshot", "uiTree", "metadata", "sensitiveRects"]
                XCTAssertEqual(keys, expected,
                               "captureNow result must contain exactly the 4 documented keys")
                exp.fulfill()
            }
        }
        wait(for: [exp], timeout: 5.0)
    }

    func testCaptureNowDoesNotLeakBinary() {
        let exp = expectation(description: "captureNow completion")
        DispatchQueue.main.async {
            TraceItXBridge.captureNow { dict, _ in
                guard let dict = dict else {
                    XCTFail("captureNow returned nil dict")
                    exp.fulfill()
                    return
                }
                // T-06-02-02 mitigation: `screenshot` is a `file://` URI String,
                // never Data / NSData. PNG bytes stay on disk.
                let value = dict["screenshot"]
                XCTAssertTrue(value is String,
                              "screenshot value must be a String URI; got \(type(of: value as Any))")
                XCTAssertFalse(value is Data, "screenshot must not leak Data across the bridge")
                XCTAssertFalse(value is NSData, "screenshot must not leak NSData across the bridge")
                if let s = value as? String {
                    XCTAssertTrue(s.hasPrefix("file://"),
                                  "screenshot URI must start with file:// (got: \(s.prefix(16)))")
                }
                exp.fulfill()
            }
        }
        wait(for: [exp], timeout: 5.0)
    }

    // MARK: - submit enqueues an outbox entry

    func testSubmitEnqueuesToOutbox() {
        let envelope: NSDictionary = [
            "schemaVersion": "v1",
            "reportId": UUID().uuidString,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "payload": ["reason": "xctest"] as NSDictionary
        ]
        let outboxBefore = TraceItXBridge._outboxCountForTesting()
        let exp = expectation(description: "submit completion")
        TraceItXBridge.submitEnvelope(envelope) { result, err in
            XCTAssertNil(err, "submitEnvelope should not error on well-formed dict")
            XCTAssertNotNil(result, "submitEnvelope should return a non-nil acknowledgement dict")
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        let outboxAfter = TraceItXBridge._outboxCountForTesting()
        XCTAssertEqual(outboxAfter, outboxBefore + 1,
                       "submit must enqueue exactly one entry into the JSONL outbox")
    }
}
#endif
