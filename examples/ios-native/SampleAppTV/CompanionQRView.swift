// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-07 — Sample tvOS host-rendered QR view.
//
// This file lives in the sample app, not the Everframe SDK. The SDK exposes
// `Everframe.shared.companion.pairUrl` and `companion.state` and ships zero
// QR-rendering or indicator chrome (SPEC §3; Phase 05.1 precedent — hosts
// own all chrome). Customers can pick any QR library they want; this sample
// uses `CIQRCodeGenerator` (Foundation built-in, zero dependencies).
//
// State-driven rendering:
//   • `.unpaired` with `pairUrl != nil` → QR + "Scan to file a bug report".
//   • `.paired`                         → "Phone connected — file from your phone".
//   • `.reportInProgress`               → "Report in progress on phone".
//   • `.phoneDisconnected`              → "Phone reconnecting…".

import SwiftUI
import Combine
import EverframeKit
#if canImport(UIKit)
import UIKit
#endif
#if canImport(CoreImage)
import CoreImage
import CoreImage.CIFilterBuiltins
#endif

struct CompanionQRView: View {
    @ObservedObject private var companion = Everframe.shared.companion

    var body: some View {
        VStack(spacing: 24) {
            switch companion.state {
            case .unpaired:
                if let url = companion.pairUrl {
                    qr(url: url)
                    // Server-resolved display name (spec 2026-08-24) lets a
                    // dashboard user match this screen to the right row in
                    // the Companion list; fall back to the short code when
                    // no name has resolved yet.
                    if let name = companion.resolvedName {
                        Text(name)
                            .font(.headline)
                    } else if let code = companion.code {
                        Text("Code: \(code)")
                            .font(.headline)
                    }
                    Text("Scan to file a bug report")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text(url)
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    ProgressView("Connecting to relay…")
                }
            case .paired:
                Image(systemName: "iphone.gen3")
                    .font(.system(size: 96))
                    .foregroundStyle(.green)
                Text("Phone connected — file a report from your phone")
                    .font(.title2)
            case .reportInProgress:
                ProgressView()
                    .scaleEffect(2)
                Text("Report in progress on phone")
                    .font(.title2)
            case .phoneDisconnected:
                Image(systemName: "iphone.slash")
                    .font(.system(size: 96))
                    .foregroundStyle(.orange)
                Text("Phone reconnecting…")
                    .font(.title2)
            }
        }
        .padding()
    }

    @ViewBuilder
    private func qr(url: String) -> some View {
        #if canImport(UIKit) && canImport(CoreImage)
        if let image = Self.generateQRCode(from: url) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(width: 400, height: 400)
        } else {
            Text(url).font(.callout)
        }
        #else
        Text(url).font(.callout)
        #endif
    }

    #if canImport(UIKit) && canImport(CoreImage)
    private static func generateQRCode(from string: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // Scale up so the QR isn't a fuzzy 25×25 — CIFilter emits tiny.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 16, y: 16))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
    #endif
}

#Preview {
    CompanionQRView()
}
