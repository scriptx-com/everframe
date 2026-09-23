// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure shot-list operations for the multi-screenshot strip. UIKit-free so
// the web-QA-locked branching (delete confirm, neighbor selection,
// add-tile cap) is unit-testable under plain swift test.
import Foundation

public enum ShotListOps {
    public static let maxShots = 5

    /// Confirm before deleting ONLY when the shot has annotations (web QA lock).
    public static func deleteNeedsConfirmation(annotationCount: Int) -> Bool {
        annotationCount > 0
    }

    /// Result of removing the shot at `index` from a list of `count` shots.
    public struct DeleteOutcome: Equatable {
        public let newActiveIndex: Int?     // nil when the list becomes empty
    }

    /// Neighbor selection: min(index, newCount - 1); deleting all is allowed.
    public static func delete(at index: Int, count: Int) -> DeleteOutcome {
        let newCount = count - 1
        return DeleteOutcome(newActiveIndex: newCount > 0 ? min(index, newCount - 1) : nil)
    }

    /// Add tile is HIDDEN (not disabled) at the cap.
    public static func showsAddTile(count: Int) -> Bool { count < maxShots }
}
