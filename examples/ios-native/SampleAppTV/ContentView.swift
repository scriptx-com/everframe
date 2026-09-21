// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// SampleAppTV ContentView. Reporting on tvOS is companion-only — navigate to
// the "Companion QR" screen, scan with a phone, file the report from the
// phone-side reporter SPA. The on-device modal reporter was removed.

import SwiftUI
import TraceItXKit

struct ContentView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 32) {
                Text("TraceItX Sample (Apple TV)")
                    .font(.largeTitle)
                Text("To file a report, open Companion QR below and scan it with your phone.")
                    .foregroundStyle(.secondary)

                HStack(spacing: 24) {
                    NavigationLink("List", destination: TVListScreen())
                    NavigationLink("Detail", destination: TVDetailScreen())
                    NavigationLink("Login (mock)", destination: TVLoginScreen())
                    NavigationLink("Payment (mock)", destination: TVPaymentScreen())
                    NavigationLink("Playback", destination: TVPlaybackScreen())
                    NavigationLink("Companion QR", destination: CompanionQRView())
                }
                .padding(.top, 24)
            }
            .padding()
            // Solid background so the screenshot capture renders honest
            // pixels — tvOS UIWindows default to transparent (the visible
            // wallpaper is the system's, not part of this app's window and
            // not capturable). Without a solid bg, transparent host areas
            // come out as opaque black in the captured PNG.
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.ignoresSafeArea())
        }
    }
}

struct TVListScreen: View {
    private let items = (1...10).map { "Item \($0)" }
    var body: some View {
        List(items, id: \.self) { Text($0) }.navigationTitle("List")
    }
}

struct TVDetailScreen: View {
    var body: some View {
        VStack(spacing: 24) {
            Text("Detail").font(.title)
            Button("Fetch https://example.com") {
                Task {
                    _ = try? await URLSession.shared.data(from: URL(string: "https://example.com/")!)
                }
            }
        }
    }
}

struct TVLoginScreen: View {
    @State private var username = ""
    @State private var password = ""
    var body: some View {
        VStack(spacing: 16) {
            TextField("Username", text: $username).frame(width: 600)
            SecureField("Password", text: $password).frame(width: 600)
        }
        .padding()
        .navigationTitle("Login")
    }
}

struct TVPaymentScreen: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("Card: 4242 4242 4242 4242").font(.title2)
            Text("(Visible only in this mock — real payment screens should call markSensitive)")
                .foregroundStyle(.secondary)
        }
        .navigationTitle("Payment")
    }
}
