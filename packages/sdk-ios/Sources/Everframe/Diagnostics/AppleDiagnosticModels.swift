// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

struct AppleDiagnosticFrame: Codable, Equatable, Sendable {
    let binaryUUID: String
    let binaryName: String
    let address: String
    let offset: String
}
struct AppleDiagnosticStack: Codable, Equatable, Sendable {
    let status: String
    let truncated: Bool
    let frames: [AppleDiagnosticFrame]
}
struct AppleDiagnosticHang: Codable, Equatable, Sendable {
    let durationMs: Double
    let stack: AppleDiagnosticStack
}
struct AppleDiagnosticExit: Codable, Equatable, Sendable {
    let state: String
    let reason: String
    let count: Int
}
/// Typed OS projection. No arbitrary metadata, process identifier or signposts.
struct AppleDiagnosticCandidate: Codable, Sendable {
    let kind: String
    let begin: Date
    let end: Date
    let applicationVersion: String
    let applicationBuild: String
    let osVersion: String
    let hangs: [AppleDiagnosticHang]
    let exits: [AppleDiagnosticExit]
    let truncated: Bool
}
