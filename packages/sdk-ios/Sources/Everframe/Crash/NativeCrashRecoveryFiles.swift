// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin

/// Inventory is deliberately specific to the pinned recorder's on-disk layout.
/// The host owns this tree exclusively; external concurrent replacement is unsupported.
enum NativeCrashRecoveryFiles {
    typealias Failure = NativeCrashRecovery.Failure
    typealias Base = NativeCrashContextFiles
    struct Inventory { var bytes = 0; var reports: [URL] = []; var entries = 0 }

    static func uuid(_ name: String) -> UUID? {
        guard let id = UUID(uuidString: name), id.uuidString.lowercased() == name else { return nil }
        return id
    }
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
    static func temporary(_ name: String) -> Bool {
        name.hasPrefix(".context-") && name.hasSuffix(".tmp") && uuid(String(name.dropFirst(9).dropLast(4))) != nil
    }
    static func scan(_ root: URL, maximum: Int) throws -> Inventory {
        var result = Inventory()
        func visit(_ directory: URL, _ components: [String]) throws {
            try Base.directory(directory)
            for name in try Base.entries(directory, maximum: 2048 - result.entries) {
                result.entries += 1
                guard result.entries <= 2048, components.count < 5 else { throw Failure.capacity }
                let path = directory.appendingPathComponent(name)
                let next = components + [name]
                var isDirectory = false
                var maxFile = maximum
                var protected = false
                switch components {
                case []:
                    if name == "recorder" { isDirectory = true }
                    else if name == "stage.evr" || temporary(name) { maxFile = 1024 * 1024; protected = true }
                    else if name == "receipt.evr" { maxFile = 4096; protected = true }
                    else { throw Failure.unsafePath }
                case ["recorder"]:
                    guard ["Reports", "Data", "RunSidecars", "Sidecars"].contains(name) else { throw Failure.unsafePath }
                    isDirectory = true
                case ["recorder", "Reports"]:
                    guard matches(name, "^Everframe-report-[0-9a-f]{16}\\.json$") else { throw Failure.unsafePath }
                    maxFile = 2 * 1024 * 1024; result.reports.append(path)
                case ["recorder", "Data"]:
                    guard ["ConsoleLog.txt", "last_run_id"].contains(name) else { throw Failure.unsafePath }
                case ["recorder", "RunSidecars"]:
                    guard uuid(name) != nil else { throw Failure.unsafePath }; isDirectory = true
                case ["recorder", "Sidecars"]:
                    guard ["Lifecycle", "Resource", "System", "UserInfo"].contains(name) else { throw Failure.unsafePath }
                    isDirectory = true
                default:
                    if components.count == 3, components[0...1] == ["recorder", "RunSidecars"] {
                        guard ["Lifecycle.ksscr", "Resource.ksscr", "System.ksscr", "UserInfo.ksscr"].contains(name) else { throw Failure.unsafePath }
                    } else if components.count == 3, components[0...1] == ["recorder", "Sidecars"] {
                        guard matches(name, "^[0-9a-f]{16}\\.ksscr$") else { throw Failure.unsafePath }
                    } else { throw Failure.unsafePath }
                }
                if isDirectory { try visit(path, next) }
                else {
                    let info = try regular(path, protected: protected)
                    guard info.st_size >= 0, info.st_size <= maxFile,
                          result.bytes <= maximum - Int(info.st_size) else { throw Failure.capacity }
                    result.bytes += Int(info.st_size)
                }
            }
        }
        try visit(root, [])
        return result
    }
    @discardableResult static func regular(_ url: URL, protected: Bool = false) throws -> stat {
        guard let info = try Base.info(url), info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == geteuid(), info.st_nlink == 1,
              info.st_mode & 0o7022 == 0,
              !protected || info.st_mode & 0o7777 == 0o600 else { throw Failure.unsafePath }
        return info
    }
    static func readRaw(_ url: URL) throws -> Data {
        let initial = try regular(url)
        let maximum = 2 * 1024 * 1024
        guard initial.st_size >= 0, initial.st_size <= maximum else { throw Failure.capacity }
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.io }
        defer { close(fd) }
        var opened = stat()
        guard fstat(fd, &opened) == 0, opened.st_dev == initial.st_dev, opened.st_ino == initial.st_ino else { throw Failure.unsafePath }
        var bytes = [UInt8](repeating: 0, count: maximum + 1)
        var count = 0
        while count < bytes.count {
            let n = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!.advanced(by: count), $0.count - count) }
            if n == 0 { break }
            if n < 0 { if errno == EINTR { continue }; throw Failure.io }
            count += n
        }
        guard count <= maximum else { throw Failure.capacity }
        return Data(bytes.prefix(count))
    }
}
