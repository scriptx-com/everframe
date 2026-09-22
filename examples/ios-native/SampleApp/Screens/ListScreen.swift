// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import SwiftUI

struct ListScreen: View {
    private let items = (1...20).map { "Item \($0)" }

    var body: some View {
        List(items, id: \.self) { item in
            NavigationLink(item, destination: DetailScreen(title: item))
        }
        .navigationTitle("List")
    }
}
