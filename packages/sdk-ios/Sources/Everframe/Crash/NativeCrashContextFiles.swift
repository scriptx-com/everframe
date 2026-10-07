// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin

/// Private, bounded filesystem operations. The caller serializes operations and
/// reserves this application-private tree against concurrent external replacement.
enum NativeCrashContextFiles {
    typealias Failure = NativeCrashContextStore.Failure

    static func info(_ url: URL) throws -> stat? {
        var value = stat()
        if lstat(url.path, &value) == 0 { return value }
        if errno == ENOENT { return nil }
        throw posixError()
    }

    static func directory(_ url: URL) throws {
        guard let value = try info(url), value.st_mode & S_IFMT == S_IFDIR,
              value.st_uid == geteuid(), value.st_mode & 0o7777 == 0o700 else { throw Failure.unsafePath }
    }

    @discardableResult static func regular(_ url: URL) throws -> stat {
        guard let value = try info(url), value.st_mode & S_IFMT == S_IFREG,
              value.st_uid == geteuid(), value.st_mode & 0o7777 == 0o600,
              value.st_nlink == 1 else { throw Failure.unsafePath }
        return value
    }

    /// One mkdir sets the final mode; umask can only clear bits. A directory that
    /// fails protection or validation is removed before the error propagates.
    static func makeDirectory(_ url: URL) throws {
        guard mkdir(url.path, 0o700) == 0 else { throw posixError() }
        do {
            try protect(url, directory: true)
            try directory(url)
        } catch {
            rmdir(url.path)
            throw error
        }
    }

    static func protect(_ url: URL, directory: Bool) throws {
        if directory {
            var target = url
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try target.setResourceValues(values)
        }
        #if canImport(UIKit)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                              ofItemAtPath: url.path)
        #endif
    }

    static func entries(_ url: URL, maximum: Int) throws -> [String] {
        try directory(url)
        let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw posixError() }
        guard let dir = fdopendir(fd) else { close(fd); throw posixError() }
        defer { closedir(dir) }
        var names: [String] = []
        while true {
            errno = 0
            guard let entry = readdir(dir) else {
                if errno != 0 { throw posixError() }
                break
            }
            var chars = entry.pointee.d_name
            let name = withUnsafePointer(to: &chars) { pointer in
                pointer.withMemoryRebound(to: CChar.self, capacity: Int(NAME_MAX) + 1) { String(validatingUTF8: $0) }
            }
            guard let name else { throw Failure.unknownEntry }
            if name == "." || name == ".." { continue }
            guard names.count < maximum else { throw Failure.capacity }
            names.append(name)
        }
        return names
    }

    static func read(_ url: URL, maximum: Int) throws -> Data {
        let initial = try regular(url)
        guard initial.st_size >= 0, initial.st_size <= maximum else { throw Failure.capacity }
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw posixError() }
        defer { close(fd) }
        var opened = stat()
        guard fstat(fd, &opened) == 0 else { throw posixError() }
        guard opened.st_dev == initial.st_dev, opened.st_ino == initial.st_ino else { throw Failure.unsafePath }
        var bytes = [UInt8](repeating: 0, count: maximum + 1)
        var count = 0
        while count < bytes.count {
            let result = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(fd, buffer.baseAddress!.advanced(by: count), buffer.count - count)
            }
            if result == 0 { break }
            if result < 0 { if errno == EINTR { continue }; throw posixError() }
            count += result
        }
        guard count <= maximum else { throw Failure.capacity }
        return Data(bytes.prefix(count))
    }

    /// Context callers supply ciphertext. Run headers contain only schema/UUID/time.
    static func writeImmutable(_ data: Data, to destination: URL) throws {
        let parent = destination.deletingLastPathComponent()
        try directory(parent)
        guard try info(destination) == nil else { throw Failure.alreadyExists }
        let temporary = parent.appendingPathComponent(".context-\(UUID().uuidString.lowercased()).tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw posixError() }
        defer { close(fd); try? FileManager.default.removeItem(at: temporary) }
        try protect(temporary, directory: false)
        var offset = 0
        while offset < data.count {
            let written = data.withUnsafeBytes { buffer in
                Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
            }
            if written < 0 { if errno == EINTR { continue }; throw posixError() }
            guard written > 0 else { throw Failure.io }
            offset += written
        }
        guard fsync(fd) == 0 else { throw posixError() }
        // Same filesystem and process-wide lock; Foundation refuses an existing target.
        try FileManager.default.moveItem(at: temporary, to: destination)
        try syncDirectory(parent)
    }

    static func syncDirectory(_ url: URL) throws {
        let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw posixError() }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw posixError() }
    }

    static func posixError() -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
}
