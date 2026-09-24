// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared gzip helper (RFC 1952). Lifted from `CompanionCaptureBridge.gzipData`
// (Phase 06.2) into a single home so BOTH the phone-companion uiTree path AND
// the session-replay timeline path (Phase 22-04) emit byte-identical gzip
// streams through one proven implementation.
//
// Apple's `Compression` framework with `COMPRESSION_ZLIB` produces RAW deflate
// (RFC 1951) per Apple's own docs — no zlib header/trailer — so we wrap the
// deflate output manually with the 10-byte gzip header + CRC32 + ISIZE trailer.
// ~30 lines, no third-party dependency.
import Foundation
import Compression

/// Stateless gzip helper. The implementation is byte-for-byte the proven
/// companion impl; the only change is hoisting it out of an instance method
/// into a `static` so the replay submit path (a `MainActor` enum) and the
/// companion bridge (a class) can both call it without an instance.
public enum Gzip {

    /// Gzip-wrap raw bytes (RFC 1952). Returns nil if the deflate step fails
    /// (caller treats a nil as "ship without the gzipped artifact", DEFE-02).
    public static func gzip(_ raw: Data) -> Data? {
        // 1. Raw deflate via Compression framework.
        let deflate = raw.withUnsafeBytes { (src: UnsafeRawBufferPointer) -> Data? in
            guard let srcPtr = src.bindMemory(to: UInt8.self).baseAddress else { return nil }
            // Generous upper bound: source size + 16 KiB. Deflate may exceed
            // source size on incompressible inputs (rare for JSON).
            let dstCapacity = raw.count + 16 * 1024 + 64
            let dstPtr = UnsafeMutablePointer<UInt8>.allocate(capacity: dstCapacity)
            defer { dstPtr.deallocate() }
            let written = compression_encode_buffer(
                dstPtr, dstCapacity,
                srcPtr, raw.count,
                nil,
                COMPRESSION_ZLIB)
            guard written > 0 else { return nil }
            return Data(bytes: dstPtr, count: written)
        }
        guard let deflate = deflate else { return nil }

        // 2. Gzip header (RFC 1952 §2.3.1): magic 1F 8B, method 08 (deflate),
        //    flags 00, mtime 00 00 00 00, xfl 00, os FF (unknown).
        var out = Data([0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF])
        out.append(deflate)

        // 3. CRC32 + ISIZE trailer (little-endian).
        let crc = crc32(raw)
        let isize = UInt32(truncatingIfNeeded: raw.count)
        out.append(contentsOf: [
            UInt8(crc & 0xFF),
            UInt8((crc >> 8) & 0xFF),
            UInt8((crc >> 16) & 0xFF),
            UInt8((crc >> 24) & 0xFF),
            UInt8(isize & 0xFF),
            UInt8((isize >> 8) & 0xFF),
            UInt8((isize >> 16) & 0xFF),
            UInt8((isize >> 24) & 0xFF),
        ])
        return out
    }

    /// CRC32 (IEEE 802.3 polynomial 0xEDB88320) — matches GZIP/zlib's CRC32.
    /// Bit-by-bit reflected form; no precomputed table — keeps the file small.
    /// For 100 KB inputs it runs in low milliseconds, plenty fast for one-shot
    /// report assembly.
    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 {
                let mask = (crc & 1) != 0 ? UInt32(0xEDB88320) : 0
                crc = (crc >> 1) ^ mask
            }
        }
        return crc ^ 0xFFFFFFFF
    }
}
