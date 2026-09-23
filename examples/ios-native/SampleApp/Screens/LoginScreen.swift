// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Demonstrates two of the three sensitive-content idioms:
//   1) UITextField.isSecureTextEntry → auto-detected, blacked out at capture time.
//   2) EFSensitiveView wrapper around an arbitrary subtree (PRIV-01).
//
// PaymentScreen demonstrates the third (Everframe.shared.markSensitive(_:)).

import SwiftUI
import UIKit
import EverframeKit

struct LoginScreen: View {
    @State private var username = ""
    @State private var password = ""
    @State private var otp = "123456"

    var body: some View {
        Form {
            Section("Visible") {
                TextField("Username", text: $username)
                    .textInputAutocapitalization(.never)
            }
            Section("Auto-detected secure (UITextField.isSecureTextEntry)") {
                SecureField("Password", text: $password)
            }
            Section("Explicit EFSensitiveView wrapper") {
                EFSensitiveBox {
                    HStack {
                        Text("OTP")
                        Spacer()
                        Text(otp).monospaced()
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .navigationTitle("Login")
    }
}

/// Bridges UIKit's `EFSensitiveView` into SwiftUI. Any SwiftUI subview hosted
/// inside this wrapper is reported as sensitive at screenshot capture time.
struct EFSensitiveBox<Content: View>: UIViewRepresentable {
    let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    func makeUIView(context: Context) -> EFSensitiveView {
        let container = EFSensitiveView()
        container.backgroundColor = .clear
        let host = UIHostingController(rootView: content())
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: container.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        // Retain host controller for the lifetime of the container view.
        objc_setAssociatedObject(container, &EFSensitiveBoxHostKey, host, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return container
    }

    func updateUIView(_ uiView: EFSensitiveView, context: Context) {
        if let host = objc_getAssociatedObject(uiView, &EFSensitiveBoxHostKey) as? UIHostingController<Content> {
            host.rootView = content()
        }
    }
}

private var EFSensitiveBoxHostKey: UInt8 = 0
