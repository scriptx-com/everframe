// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import XCTest
@testable import TraceItXKit
import TraceItXProtocol

final class BreadcrumbTrimTests: XCTestCase {
    // MARK: - Parity fixture

    private struct Options: Decodable {
        let byteBudget: Int
        let consoleEntryCap: Int
    }

    private struct Case: Decodable {
        let name: String
        let options: Options
        let input: [Breadcrumb]
        let expected: [Breadcrumb]
    }

    private struct Fixture: Decodable {
        let cases: [Case]
    }

    /// Canonical JSON (sorted keys) for a `[Breadcrumb]` array — used as the
    /// deep-equality check since `Breadcrumb` isn't `Equatable` (its `data`
    /// field is `[String: JSONAny]`, and `JSONAny` doesn't conform either).
    private func canonicalJSON(_ crumbs: [Breadcrumb]) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(crumbs)
        return String(decoding: data, as: UTF8.self)
    }

    func test_parity_fixture_all_cases() throws {
        // Anchor on this source file and walk up to the repo root:
        // Tests/TraceItXTests/BreadcrumbTrimTests.swift
        //   -> Tests/TraceItXTests
        //   -> Tests
        //   -> sdk-ios
        //   -> packages
        // then append protocol/__tests__/fixtures/breadcrumb-trim.v1.json.
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("protocol/__tests__/fixtures/breadcrumb-trim.v1.json")

        let data = try Data(contentsOf: fixtureURL)

        // Matches Generated.swift's newJSONDecoder() (iso8601 dates); breadcrumb
        // `t` is a numeric epoch so the date strategy is inert here, but we
        // match it for consistency with the rest of the generated model.
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let fixture = try decoder.decode(Fixture.self, from: data)

        XCTAssertFalse(fixture.cases.isEmpty, "fixture must contain at least one case")

        for c in fixture.cases {
            let actual = BreadcrumbTrim.trim(
                c.input,
                byteBudget: c.options.byteBudget,
                consoleEntryCap: c.options.consoleEntryCap
            )
            let actualJSON = try canonicalJSON(actual)
            let expectedJSON = try canonicalJSON(c.expected)
            XCTAssertEqual(actualJSON, expectedJSON, "case=\(c.name)")
        }
    }

    // MARK: - Count-cap port (mirrors sdk-core's 200-crumb count-cap test)

    func test_countCap_enforcesProtocolCeilingEvenUnderByteBudget() {
        // 200 cheap same-kind crumbs, effectively unlimited byte budget: the
        // byte pass evicts nothing, so the count pass must bring kept down to
        // maxTrimmedEntries (121).
        let taps: [Breadcrumb] = (0..<200).map { i in
            Breadcrumb(
                data: nil, kind: .tap, level: nil, message: "tap-btn-x",
                seq: i, t: Double(i + 1), truncated: nil
            )
        }
        let out = BreadcrumbTrim.trim(taps, byteBudget: 10_000_000, consoleEntryCap: 1024)
        XCTAssertLessThanOrEqual(out.count, 128)

        let markers = out.filter { BreadcrumbTrim.isTrimMarker($0) }
        let kept = out.filter { !BreadcrumbTrim.isTrimMarker($0) }

        XCTAssertEqual(markers.count, 1)
        XCTAssertEqual(markers.first?.kind, .tap)
        XCTAssertEqual(markers.first?.message, "+79 tap hidden")
        XCTAssertEqual(markers.first?.data?["droppedCount"]?.value as? Int64, 79)
        // Marker is stamped with the newest dropped entry (t=79) so it sorts first.
        XCTAssertEqual(markers.first?.t, 79)

        // Kept entries are exactly the NEWEST 121 (t=80..200).
        XCTAssertEqual(kept.count, BreadcrumbTrim.maxTrimmedEntries)
        XCTAssertEqual(kept.first?.t, 80)
        XCTAssertEqual(kept.last?.t, 200)
    }

    // MARK: - Combined byte-eviction + count-cap (Task 3, ported from sdk-core's
    // "locks a combined byte-eviction + count-cap run identically across
    // TS/Swift/Kotlin" test — see fixture __semantics point 7). Numbers below
    // are hard-coded from the actual TS run; any divergence here is a real
    // cross-SDK parity defect.

    func test_combinedByteEvictionAndCountCap_locksTsOutcomeNumbers() {
        let taps: [Breadcrumb] = (0..<130).map { i in
            Breadcrumb(
                data: nil, kind: .tap, level: nil, message: "tap-btn",
                seq: i, t: Double(i + 1), truncated: nil
            )
        }
        let consoles: [Breadcrumb] = (0..<5).map { i in
            Breadcrumb(
                data: nil, kind: .console, level: nil, message: String(repeating: "c", count: 1500),
                seq: 200 + i, t: Double(200 + i), truncated: nil
            )
        }
        let input = taps + consoles

        let out = BreadcrumbTrim.trim(input, byteBudget: 12000, consoleEntryCap: 1024)
        let markers = out.filter { BreadcrumbTrim.isTrimMarker($0) }
        let kept = out.filter { !BreadcrumbTrim.isTrimMarker($0) }

        XCTAssertLessThanOrEqual(out.count, BreadcrumbTrim.maxTrimmedEntries + markers.count)
        XCTAssertLessThanOrEqual(kept.count, BreadcrumbTrim.maxTrimmedEntries)

        // Exactly one marker per kind that lost entries.
        XCTAssertEqual(markers.count, 2)
        let consoleMarker = markers.first { $0.kind == .console }
        let tapMarker = markers.first { $0.kind == .tap }
        XCTAssertNotNil(consoleMarker)
        XCTAssertNotNil(tapMarker)

        let consoleDropped = consoleMarker?.data?["droppedCount"]?.value as? Int64
        let tapDropped = tapMarker?.data?["droppedCount"]?.value as? Int64
        XCTAssertEqual(consoleDropped, 4)
        XCTAssertEqual(tapDropped, 10)

        // Conservation: every one of the 135 input entries is kept or
        // accounted for by exactly one marker's droppedCount.
        XCTAssertEqual(Int(consoleDropped ?? 0) + Int(tapDropped ?? 0) + kept.count, 135)

        // Recorded concrete outcome (hard-coded from the TS run).
        XCTAssertEqual(kept.count, 121)
        XCTAssertEqual(consoleMarker?.t, 203)
        XCTAssertEqual(consoleMarker?.seq, 203)
        XCTAssertEqual(tapMarker?.t, 10)
        XCTAssertEqual(tapMarker?.seq, 9)

        // Must-keep: the newest tap (t=130) survives even though its kind lost entries.
        XCTAssertTrue(kept.contains { $0.kind == .tap && $0.t == 130 })

        // NOTE (matches the TS test's NOTE): flipping byteBudget to a huge
        // value on THIS SAME 135-entry input does NOT make the console marker
        // vanish — the count-cap pass reuses the same bulky-before-structural
        // eviction order, and with only 4 non-must-keep consoles available,
        // all 4 get evicted by the count pass alone regardless of budget.
        // Verified below; the genuine byte-pass-fired sanity check (where
        // count-cap can never engage) is the sibling test right after this one.
        let outHugeBudget = BreadcrumbTrim.trim(input, byteBudget: 10_000_000, consoleEntryCap: 1024)
        let consoleMarkerHugeBudget = outHugeBudget
            .filter { BreadcrumbTrim.isTrimMarker($0) }
            .first { $0.kind == .console }
        XCTAssertEqual(consoleMarkerHugeBudget?.t, 203)
        XCTAssertEqual(consoleMarkerHugeBudget?.seq, 203)
        XCTAssertEqual(consoleMarkerHugeBudget?.data?["droppedCount"]?.value as? Int64, 4)
    }

    func test_byteEvictionPass_sanityRespondsToByteBudgetWhenCountCapCannotEngage() {
        // Only 6 total entries — far under maxTrimmedEntries (121), so the
        // count-cap pass can never fire regardless of byteBudget. This
        // isolates the byte-eviction pass: a tight budget forces console
        // eviction; a huge budget evicts nothing at all.
        let taps: [Breadcrumb] = (0..<3).map { i in
            Breadcrumb(
                data: nil, kind: .tap, level: nil, message: "tap-btn",
                seq: i, t: Double(i + 1), truncated: nil
            )
        }
        let consoles: [Breadcrumb] = (0..<3).map { i in
            Breadcrumb(
                data: nil, kind: .console, level: nil, message: String(repeating: "c", count: 1500),
                seq: 200 + i, t: Double(200 + i), truncated: nil
            )
        }
        let input = taps + consoles

        let tight = BreadcrumbTrim.trim(input, byteBudget: 2000, consoleEntryCap: 1024)
        let tightMarkers = tight.filter { BreadcrumbTrim.isTrimMarker($0) }
        XCTAssertEqual(tightMarkers.count, 1)
        XCTAssertEqual(tightMarkers.first?.kind, .console)
        XCTAssertEqual(tightMarkers.first?.t, 201)
        XCTAssertEqual(tightMarkers.first?.seq, 201)
        XCTAssertEqual(tightMarkers.first?.data?["droppedCount"]?.value as? Int64, 2)

        let huge = BreadcrumbTrim.trim(input, byteBudget: 10_000_000, consoleEntryCap: 1024)
        XCTAssertEqual(huge.filter { BreadcrumbTrim.isTrimMarker($0) }.count, 0)
        XCTAssertEqual(huge.count, 6) // nothing evicted at all
    }

    // MARK: - Surrogate-split characterization (accepted platform divergence)

    func test_surrogateSplit_swiftSubstitutesUFFFD() {
        // 511 'a' + '😀' (0xD83D 0xDE00) + 600 'b' = 1113 UTF-16 units, run
        // through the trim entry point with consoleEntryCap 1024 (huge
        // byteBudget so only the console cap fires). half = 512, so the head
        // keeps units [0..511]; unit 511 is the emoji's high surrogate and its
        // low-surrogate partner (unit 512) is dropped, splitting the pair.
        // Swift's String(decoding:as:UTF16.self) cannot hold a lone surrogate,
        // so it substitutes U+FFFD — unlike JS .slice()/Kotlin substring,
        // which keep the lone high surrogate verbatim (see breadcrumb-trim.spec.ts
        // and BreadcrumbTrimTest.kt for the counterpart).
        let message = String(repeating: "a", count: 511) + "😀" + String(repeating: "b", count: 600)
        let crumb = Breadcrumb(
            data: nil, kind: .console, level: nil, message: message,
            seq: 0, t: 1, truncated: nil
        )
        let out = BreadcrumbTrim.trim([crumb], byteBudget: 10_000_000, consoleEntryCap: 1024)
        XCTAssertEqual(out.first?.truncated, true)
        let units = Array(out.first!.message.utf16)
        XCTAssertEqual(units[511], 0xFFFD)
    }

    // MARK: - isTrimMarker

    func test_isTrimMarker_discriminatesOnNumericDroppedCount() throws {
        let numeric = try JSONDecoder().decode(
            [String: JSONAny].self, from: "{\"droppedCount\":3}".data(using: .utf8)!
        )
        let markerCrumb = Breadcrumb(
            data: numeric, kind: .console, level: nil, message: "m", seq: 0, t: 1, truncated: nil
        )
        XCTAssertTrue(BreadcrumbTrim.isTrimMarker(markerCrumb))

        let nonNumeric = try JSONDecoder().decode(
            [String: JSONAny].self, from: "{\"droppedCount\":\"x\"}".data(using: .utf8)!
        )
        let stringCrumb = Breadcrumb(
            data: nonNumeric, kind: .console, level: nil, message: "m", seq: 0, t: 1, truncated: nil
        )
        XCTAssertFalse(BreadcrumbTrim.isTrimMarker(stringCrumb))

        let noDataCrumb = Breadcrumb(
            data: nil, kind: .console, level: nil, message: "m", seq: 0, t: 1, truncated: nil
        )
        XCTAssertFalse(BreadcrumbTrim.isTrimMarker(noDataCrumb))
    }
}
