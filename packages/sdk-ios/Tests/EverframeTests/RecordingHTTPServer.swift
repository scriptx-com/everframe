// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// A minimal, REAL local HTTP/1.1 server — plain POSIX sockets, the same
/// binding technique `RelayWSClientCompanionTests.swift`'s
/// `ParkedWebSocketServer` already established as necessary: `NWListener`
/// fails to bind at all inside the `xctest` host process
/// (`failed(POSIXErrorCode(rawValue: 22): Invalid argument)`), while plain
/// `socket`/`bind`/`listen` on 127.0.0.1 works there. Measured, not assumed
/// — see that type's own doc comment.
///
/// Independent review, round 13, Serious — exists specifically because a
/// `URLProtocol`-based mock (`RecordingURLProtocol`, used elsewhere in this
/// test target) CANNOT answer "what does Foundation actually do to a
/// custom header across a cross-origin redirect": a custom `URLProtocol`
/// substitutes the real network transport entirely, and to simulate a
/// redirect it must construct its OWN proposed follow-up request and hand
/// it to `URLProtocolClient.urlProtocol(_:wasRedirectedTo:redirectResponse:)`
/// — the TEST decides what that request looks like, not Foundation. Only a
/// REAL two-hop network round-trip exercises Foundation's actual
/// header-copying logic. This is a genuine (if minimal) HTTP server: it
/// reads real bytes off a real socket, parses real request lines/headers,
/// and writes a real HTTP response — so a `URLSession` pointed at it is
/// doing exactly what it would do against a real ingest server, redirect
/// included.
///
/// Deliberately NOT a general-purpose test server: no chunked encoding, no
/// keep-alive reuse across multiple requests on one connection, no request
/// body streaming. Every request this Everframe SDK's own upload path sends is
/// small and bounded (multipart envelope + attachments, capped upstream),
/// and every response this server needs to send is either a redirect (no
/// body) or a short fixed body — enough to drive one real cross-origin
/// redirect end to end and record exactly what arrived.
final class RecordingHTTPServer: @unchecked Sendable {
    struct RecordedRequest {
        let method: String
        let path: String
        let headers: [String: String]
        /// Independent review, round 15, Critical — the raw request BODY,
        /// not just headers. The redirect-guard tests (round 13) never
        /// needed this (only the header the redirect might carry mattered),
        /// but proving "evidence is not in the envelope" end to end means
        /// inspecting what actually arrived on the wire, not merely the
        /// bytes handed to `submit(...)` before it POSTs them.
        let body: Data
    }

    /// What to answer for the NEXT accepted connection's request. Read
    /// fresh per-connection (under `lock`) so a test can reconfigure a
    /// server between requests (e.g. server A always redirects; server B
    /// always answers 200) or even change behaviour mid-test.
    var respond: (RecordedRequest) -> (status: Int, headers: [String: String], body: Data) = { _ in
        (200, [:], Data())
    }

    private let listenFD: Int32
    private let lock = NSLock()
    private var stopped = false
    private var _recorded: [RecordedRequest] = []

    var recorded: [RecordedRequest] {
        lock.lock(); defer { lock.unlock() }
        return _recorded
    }

    let port: UInt16
    /// `http://127.0.0.1:<port>` — callers that want to test a DIFFERENT
    /// hostname for the same server (still loopback, still this process)
    /// can build their own `URL(string: "http://localhost:\(port)")`.
    var url: URL { URL(string: "http://127.0.0.1:\(port)")! }

    enum ServerError: Error {
        case socketFailed(Int32)
        case bindFailed(Int32)
        case listenFailed(Int32)
        case portUnavailable(Int32)
    }

    init() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ServerError.socketFailed(errno) }

        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0  // ephemeral — never collides with a parallel test
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let didBind = withUnsafePointer(to: &addr) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard didBind == 0 else {
            let err = errno; close(fd); throw ServerError.bindFailed(err)
        }
        guard listen(fd, 8) == 0 else {
            let err = errno; close(fd); throw ServerError.listenFailed(err)
        }

        var bound = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let didRead = withUnsafeMutablePointer(to: &bound) { raw in
            raw.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &length)
            }
        }
        guard didRead == 0 else {
            let err = errno; close(fd); throw ServerError.portUnavailable(err)
        }

        listenFD = fd
        port = UInt16(bigEndian: bound.sin_port)
        Thread.detachNewThread { [self] in acceptLoop() }
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 {
                if errno == EINTR { continue }
                return  // listening socket closed by stop() — we're done
            }
            handle(fd)
        }
    }

    private func handle(_ fd: Int32) {
        defer { close(fd) }
        guard let request = Self.readRequest(fd: fd) else { return }

        lock.lock()
        _recorded.append(request)
        let responder = respond
        lock.unlock()

        let (status, headers, body) = responder(request)
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 302: statusText = "Found"
        default: statusText = "Status"
        }
        var head = "HTTP/1.1 \(status) \(statusText)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        for (key, value) in headers {
            head += "\(key): \(value)\r\n"
        }
        head += "Connection: close\r\n\r\n"
        var payload = Data(head.utf8)
        payload.append(body)
        payload.withUnsafeBytes { raw in
            var offset = 0
            let base = raw.baseAddress!
            while offset < raw.count {
                let n = write(fd, base + offset, raw.count - offset)
                if n <= 0 { break }
                offset += n
            }
        }
    }

    /// Reads until the blank line ending the headers (`\r\n\r\n`) — every
    /// request this server needs to handle is a redirect follow-up (GET,
    /// no body) or the initial small multipart POST, both of which fit
    /// comfortably inside a handful of reads.
    private static func readRequest(fd: Int32) -> RecordedRequest? {
        var buffer = Data()
        let terminator = Data("\r\n\r\n".utf8)
        var chunk = [UInt8](repeating: 0, count: 8192)
        while buffer.range(of: terminator) == nil {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
        }
        guard let headerEnd = buffer.range(of: terminator),
              let text = String(data: buffer[buffer.startIndex..<headerEnd.lowerBound], encoding: .utf8)
        else { return nil }

        let lines = text.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0])
        let path = String(parts[1])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if !key.isEmpty { headers[key] = value }
        }

        // Body — whatever's already in `buffer` past the header terminator
        // (read in the SAME read() call(s) above) counts first, then top up
        // with more reads until Content-Length bytes have arrived. Case-
        // insensitive lookup: HTTP header names are not case-sensitive, and
        // URLSession's own multipart POST spells it "Content-Length".
        var body = Data(buffer[headerEnd.upperBound...])
        let contentLength = headers.first { $0.key.caseInsensitiveCompare("Content-Length") == .orderedSame }
            .flatMap { Int($0.value) } ?? 0
        while body.count < contentLength {
            let n = read(fd, &chunk, min(chunk.count, contentLength - body.count))
            if n <= 0 { break }
            body.append(contentsOf: chunk[0..<n])
        }
        return RecordedRequest(method: method, path: path, headers: headers, body: body)
    }

    func stop() {
        lock.lock()
        if stopped { lock.unlock(); return }
        stopped = true
        lock.unlock()
        // Closing a descriptor from another thread does not reliably wake a
        // blocking accept(). Shut the socket down first so the detached accept
        // loop exits instead of surviving into a later test after port reuse.
        shutdown(listenFD, SHUT_RDWR)
        close(listenFD)
    }
}
