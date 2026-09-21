// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SwiftUI entry surface for TraceItX. Hosts wrap arbitrary SwiftUI views with
// `.traceItXReporter(isPresented:)` or `.traceItXReporter(item:)` to invoke the
// reporter modal (UIKit internals). The modifier wraps a UIViewControllerRepresentable
// that embeds TXReporterViewController inside a UINavigationController.
//
// Why UIKit internals (CONTEXT decision 1): the annotation surface needs
// CALayer + UIVisualEffectView + gesture recognizers — SwiftUI's drawing
// primitives are too constrained (no efficient blur baking path), and our
// minimum deployment target is iOS 16 where some SwiftUI APIs (Observable,
// onChange(of:_:initial:)) are not yet available.
#if canImport(SwiftUI) && canImport(UIKit) && !os(tvOS)
import SwiftUI
import UIKit
import TraceItXKit
import TraceItXProtocol

/// Token type accepted by `.traceItXReporter(item:)`. Hosts can subclass or
/// embed metadata fields they want to forward into the reporter context.
public struct PresentToken: Identifiable, Hashable {
    public let id: UUID
    public init(id: UUID = UUID()) { self.id = id }
}

@MainActor
public extension View {
    /// Present the reporter when `isPresented` flips to `true`. Mirrors the
    /// signature of SwiftUI's `.sheet(isPresented:)` — the modifier flips
    /// `isPresented` back to `false` once the user submits or cancels.
    func traceItXReporter(isPresented: Binding<Bool>) -> some View {
        modifier(TraceItXReporterModifier(isPresented: isPresented, item: .constant(nil as PresentToken?)))
    }

    /// Present the reporter when `item` becomes non-nil. Mirrors `.sheet(item:)`.
    func traceItXReporter(item: Binding<PresentToken?>) -> some View {
        modifier(TraceItXReporterModifier(isPresented: .constant(false), item: item))
    }
}

@MainActor
struct TraceItXReporterModifier: ViewModifier {
    @Binding var isPresented: Bool
    @Binding var item: PresentToken?

    func body(content: Content) -> some View {
        // The reporter modal is hosted in its own `UIWindow` (built and
        // dismissed by `ReporterWindowController`), so SwiftUI does not need
        // a `UIViewControllerRepresentable` to drive presentation. We simply
        // observe the binding and open the reporter when it flips to `true`.
        content
            .onChange(of: isPresented) { newValue in
                guard newValue else { return }
                Task { @MainActor in
                    _ = try? await TXReporterPresenter.openAndAwait()
                    isPresented = false
                }
            }
            .onChange(of: item) { newValue in
                guard newValue != nil else { return }
                Task { @MainActor in
                    _ = try? await TXReporterPresenter.openAndAwait()
                    item = nil
                }
            }
    }
}
#endif
