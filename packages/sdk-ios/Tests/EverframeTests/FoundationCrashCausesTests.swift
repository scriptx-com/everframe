// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import XCTest
@testable import EverframeKit
import EverframeProtocol

final class FoundationCrashCausesTests: XCTestCase {
    private func capture(_ error: any Error) -> EverframeCrashCauseChain? {
        captureFoundationCauseChain(error, redact: { $0 }, stillOwned: { true })
    }
    func testUnderlyingFramesAreEmptyAndTypesUseNSErrorDomainCode() throws {
        let tail = NSError(domain: "tail", code: 3, userInfo: [NSLocalizedDescriptionKey: "root cause"])
        let inner = NSError(domain: "inner", code: 2, userInfo: [NSUnderlyingErrorKey: tail, NSLocalizedDescriptionKey: "inner message"])
        let root = NSError(domain: "outer", code: 1, userInfo: [NSUnderlyingErrorKey: inner])
        let chain = try XCTUnwrap(capture(root))
        XCTAssertEqual(chain.causes.map(\.exceptionType), ["inner:2", "tail:3"])
        XCTAssertEqual(chain.causes.map(\.message), ["inner message", "root cause"])
        XCTAssertTrue(chain.causes.allSatisfy { $0.frames.isEmpty && !$0.framesTruncated })
        XCTAssertFalse(chain.truncated)
    }
    func testCustomNSErrorLinksAndPlainSwiftAbsence() throws {
        struct Plain: Error {}
        struct Linked: CustomNSError {
            var errorUserInfo: [String: Any] { [NSUnderlyingErrorKey: Plain(), NSLocalizedDescriptionKey: "linked"] }
        }
        XCTAssertNil(capture(Plain()))
        let root = NSError(domain: "outer", code: 1, userInfo: [NSUnderlyingErrorKey: Linked()])
        let chain = try XCTUnwrap(capture(root))
        XCTAssertEqual(chain.causes.count, 2)
        XCTAssertTrue(chain.causes[0].exceptionType.hasSuffix("Linked"))
        XCTAssertTrue(chain.causes[1].exceptionType.hasSuffix("Plain"))
        XCTAssertEqual(chain.causes[0].message, "linked")
    }
    func testCyclesAndDepthAreBounded() throws {
        let a = MutableUnderlyingError(), b = MutableUnderlyingError()
        a.underlying = b; b.underlying = a
        defer { a.underlying = nil; b.underlying = nil }
        let cycle = try XCTUnwrap(capture(a))
        XCTAssertEqual(cycle.causes.count, 1); XCTAssertTrue(cycle.truncated)
        func chain(_ n: Int) -> NSError {
            var error = NSError(domain: "tail", code: 0)
            for i in 0..<n { error = NSError(domain: "link", code: i, userInfo: [NSUnderlyingErrorKey: error]) }
            return error
        }
        XCTAssertFalse(try XCTUnwrap(capture(chain(8))).truncated)
        let over = try XCTUnwrap(capture(chain(9)))
        XCTAssertEqual(over.causes.count, 8); XCTAssertTrue(over.truncated)
    }
    func testUnsupportedBranchesAreMarkedWithoutFlatteningOrHostDescriptions() throws {
        let inner = NSError(domain: "inner", code: 2)
        let root = NSError(domain: "outer", code: 1, userInfo: [NSUnderlyingErrorKey: inner, NSMultipleUnderlyingErrorsKey: [inner, inner]])
        let chain = try XCTUnwrap(capture(root))
        XCTAssertEqual(chain.causes.count, 1); XCTAssertTrue(chain.truncated)
        final class Unsupported: NSObject {
            override var description: String { XCTFail("unsupported description called"); return "bad" }
        }
        let lost = try XCTUnwrap(capture(NSError(domain: "outer", code: 1, userInfo: [NSUnderlyingErrorKey: Unsupported()])))
        XCTAssertTrue(lost.causes.isEmpty); XCTAssertTrue(lost.truncated)
    }
    func testOwnershipLossInUserInfoStopsBeforeDescription() {
        var owned = true
        let inner = MutableUnderlyingError()
        inner.onRead = { owned = false }
        inner.onDescription = { XCTFail("description after ownership loss") }
        let root = NSError(domain: "outer", code: 1, userInfo: [NSUnderlyingErrorKey: inner])
        XCTAssertNil(captureFoundationCauseChain(root, redact: { $0 }, stillOwned: { owned }))
    }
}

final class MutableUnderlyingError: NSError, @unchecked Sendable {
    var underlying: (any Error)?
    var onRead: (() -> Void)?
    var onDescription: (() -> Void)?
    init() { super.init(domain: "mutable", code: 1, userInfo: nil) }
    required init?(coder: NSCoder) { fatalError("unused") }
    override var userInfo: [String: Any] {
        onRead?()
        return underlying.map { [NSUnderlyingErrorKey: $0] } ?? [:]
    }
    override var localizedDescription: String { onDescription?(); return "mutable cause" }
}
