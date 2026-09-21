// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Demonstrates `TraceItX.shared.markSensitive(_:)` — the public passthrough
// for marking any UIView (including ones whose class you don't own) as
// sensitive without subclassing TXSensitiveView.

import SwiftUI
import UIKit
import TraceItXKit

struct PaymentScreen: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("Demo of TraceItX.shared.markSensitive(_:) for views you don't own")
                .multilineTextAlignment(.center)
                .padding()
            CreditCardInputBridge()
                .frame(height: 80)
                .padding(.horizontal)
            Spacer()
        }
        .navigationTitle("Payment")
    }
}

/// A custom UIKit view that we don't subclass; the underlying UIView is
/// instead marked via `TraceItX.shared.markSensitive(_:)` after creation.
struct CreditCardInputBridge: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let card = UIView()
        card.backgroundColor = UIColor.systemGray6
        card.layer.cornerRadius = 12

        let tf = UITextField()
        tf.placeholder = "Card number"
        tf.text = "4242 4242 4242 4242"
        tf.font = UIFont.monospacedSystemFont(ofSize: 18, weight: .regular)
        tf.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(tf)
        NSLayoutConstraint.activate([
            tf.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 16),
            tf.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -16),
            tf.centerYAnchor.constraint(equalTo: card.centerYAnchor),
        ])

        // Public-API demo: mark the entire card view as sensitive at runtime.
        TraceItX.shared.markSensitive(card)
        return card
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}
