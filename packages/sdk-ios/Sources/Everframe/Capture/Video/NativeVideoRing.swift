// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

struct NativeVideoSegment: Sendable {
    let url: URL
    let startNanos: UInt64
    let endNanos: UInt64
    let byteCount: Int
    /// Capture time of the final real sample, distinct from its encoded hold end.
    var lastFrameNanos: UInt64? = nil

    func canPrecede(_ next: NativeVideoSegment) -> Bool {
        if next.startNanos >= endNanos { return true }
        // Only a terminal sample's hold may overlap a newer real capture.
        return lastFrameNanos.map { next.startNanos > $0 } ?? false
    }
}

/// Single-owner retention of complete, independently decodable segments.
/// The recording actor serializes mutation. `drain` transfers file ownership.
struct NativeVideoRing: Sendable {
    private let directory: URL
    private let durationNanos: UInt64
    private let byteLimit: Int
    private(set) var segments: [NativeVideoSegment] = []
    var byteCount: Int { segments.reduce(0) { $0 + $1.byteCount } }

    init(directory: URL, durationNanos: UInt64, byteLimit: Int) {
        self.directory = directory.appendingPathComponent("", isDirectory: true).standardizedFileURL
        self.durationNanos = durationNanos
        self.byteLimit = max(0, byteLimit)
    }

    @discardableResult mutating func insert(_ segment: NativeVideoSegment) throws -> Bool {
        // Never delete arbitrary paths supplied by a caller or an existing entry.
        guard segment.url.isFileURL,
              segment.url.deletingLastPathComponent().standardizedFileURL == directory,
              !segments.contains(where: { $0.url.standardizedFileURL == segment.url.standardizedFileURL })
        else { return false }
        let attributes = try FileManager.default.attributesOfItem(atPath: segment.url.path)
        let actualBytes = (attributes[.size] as? NSNumber)?.intValue
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              actualBytes == segment.byteCount,
              segment.byteCount > 0, segment.byteCount <= byteLimit,
              segment.endNanos > segment.startNanos,
              segment.endNanos - segment.startNanos <= durationNanos,
              segment.lastFrameNanos.map({ $0 >= segment.startNanos && $0 < segment.endNanos }) ?? true,
              segments.last.map({ $0.canPrecede(segment) }) ?? true
        else {
            try FileManager.default.removeItem(at: segment.url)
            return false
        }
        // Evict before insertion: retained bytes never transiently exceed budget.
        let windowStart = segment.endNanos > durationNanos ? segment.endNanos - durationNanos : 0
        while let first = segments.first {
            let nextStart = segments.count > 1 ? segments[1].startNanos : segment.startNanos
            // A final captured frame holds until the next real segment starts.
            // Keep at most one predecessor before the logical window when that
            // hold intersects it, including across an arbitrarily long idle.
            let holdsIntoWindow = first.lastFrameNanos != nil && nextStart > windowStart
            let expired = segment.endNanos - first.startNanos > durationNanos && !holdsIntoWindow
            guard expired || byteCount > byteLimit - segment.byteCount else { break }
            try removeFirst()
        }
        segments.append(segment)
        return true
    }

    mutating func clear() throws {
        while !segments.isEmpty { try removeFirst() }
    }

    mutating func drain() -> [NativeVideoSegment] {
        let frozen = segments
        segments.removeAll()
        return frozen
    }

    private mutating func removeFirst() throws {
        let url = segments[0].url
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        segments.removeFirst()
    }
}
