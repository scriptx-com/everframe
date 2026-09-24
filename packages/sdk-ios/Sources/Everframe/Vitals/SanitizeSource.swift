// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Signed CDN and licence URLs carry tokens in the query — stripped by default.
import Foundation

struct SanitizedSource: Equatable { let src: String; let `protocol`: String }

private let unknownSource = SanitizedSource(src: "unknown", protocol: "unknown")
private let progressiveExt: Set<String> = ["mp4", "m4v", "webm", "ogg", "ogv", "mov", "mp3", "aac", "m4a", "wav", "flac"]

func protocolForPath(_ path: String) -> String {
    guard let dot = path.lastIndex(of: ".") else { return "unknown" }
    let ext = path[path.index(after: dot)...].lowercased()
    switch ext {
    case "m3u8": return "hls"
    case "mpd": return "dash"
    default: return progressiveExt.contains(ext) ? "progressive" : "unknown"
    }
}

func protocolForMime(_ mime: String?) -> String? {
    guard let m = mime?.lowercased() else { return nil }
    if m == "application/x-mpegurl" || m == "application/vnd.apple.mpegurl" { return "hls" }
    if m == "application/dash+xml" { return "dash" }
    if m.hasPrefix("video/") || m.hasPrefix("audio/") { return "progressive" }
    return nil
}

func sanitizeSource(_ raw: String?, keepQuery: Bool = false) -> SanitizedSource {
    guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return unknownSource }
    for local in ["file:", "asset:"] where raw.hasPrefix(local) { return SanitizedSource(src: local, protocol: "unknown") }
    guard let components = URLComponents(string: raw), let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https", let host = components.host, !host.isEmpty else { return unknownSource }
    let port = components.port.map { ":\($0)" } ?? ""
    let path = components.percentEncodedPath
    let query = keepQuery ? (components.percentEncodedQuery.map { "?\($0)" } ?? "") : ""
    return SanitizedSource(src: "\(scheme)://\(host)\(port)\(path)\(query)", protocol: protocolForPath(path))
}
