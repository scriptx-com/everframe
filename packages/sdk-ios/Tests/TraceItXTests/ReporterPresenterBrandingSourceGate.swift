// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// #137 review follow-up — host-runnable source gate for the branding
// presentation wiring in TXReporterPresenter.swift, which is UIKit-gated and
// has NO runtime test by design (iOS spec 2026-08-26, Approach A: resolve
// ONCE per presentation; CI's xcodebuild job is the behavioural verifier).
// Mirrors ReporterOpenIdentityWarmSourceGate: read the source file as text,
// strip line comments, pin the load-bearing call sites. If either assertion
// fires, the reporter would present unbranded (or, worse, unwatermarked)
// without any other test noticing on the host toolchain.
import XCTest

final class TXReporterPresenterBrandingSourceGate: XCTestCase {
    private static func packageRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // TraceItXTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // package root
    }

    private static func source(_ relativePath: String) throws -> String {
        try String(contentsOf: packageRoot().appendingPathComponent(relativePath), encoding: .utf8)
    }

    private static func strippingLineComments(_ source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                guard let slashes = line.range(of: "//") else { return line }
                return line[line.startIndex..<slashes.lowerBound]
            }
            .joined(separator: "\n")
    }

    func testPresenterResolvesThemeAndWatermarkFromTheServerBox() throws {
        let code = Self.strippingLineComments(
            try Self.source("Sources/TraceItXReporterUI/TXReporterPresenter.swift"))

        XCTAssertNotNil(
            code.range(of: "BrandingServerConfigBox.shared.value"),
            """
            TXReporterPresenter.swift no longer snapshots BrandingServerConfigBox.shared.value at \
            presentation. Both the watermark gate and the theme resolution must read the SAME \
            server snapshot — losing the read breaks resolve-once-per-presentation (iOS spec, \
            Approach A).
            """
        )
        XCTAssertNotNil(
            code.range(of: "shouldShowWatermark(brandingServer"),
            """
            TXReporterPresenter.swift no longer derives the watermark from \
            shouldShowWatermark(brandingServer…). The watermark MUST come from the server \
            entitlement snapshot — fail closed to watermarked — never from a local default or \
            the inline theme.
            """
        )
        XCTAssertNotNil(
            code.range(of: "ThemeResolver.resolve(server: brandingServer"),
            """
            TXReporterPresenter.swift no longer resolves the palette via \
            ThemeResolver.resolve(server: brandingServer…). Presentation must run the \
            server → inline → default precedence against the same server snapshot the \
            watermark gate uses.
            """
        )
    }
}
