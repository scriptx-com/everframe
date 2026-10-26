// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Darwin
@testable import EverframeKit

final class NativeCrashContextFilesTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    /// readdir sizes each entry to its name (d_reclen), so an entry can end a few bytes before an
    /// unmapped page. Reading the name must stay inside the entry: copying the fixed 1024-byte
    /// d_name faulted in production with the readdir buffer at the end of a malloc region.
    func testNameReadsOnlyTheEntryBeforeAnUnmappedPage() throws {
        let page = Int(getpagesize())
        let mapping = try XCTUnwrap(mmap(nil, page * 2, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0))
        XCTAssertNotEqual(mapping, MAP_FAILED)
        defer { munmap(mapping, page * 2) }
        XCTAssertEqual(mprotect(mapping.advanced(by: page), page, PROT_NONE), 0)

        let name = Array("context-1.bin".utf8)
        let nameOffset = try XCTUnwrap(MemoryLayout<dirent>.offset(of: \dirent.d_name))
        let length = (nameOffset + name.count + 1 + 3) & ~3
        let entry = mapping.advanced(by: page - length)
        memset(entry, 0, length)
        entry.storeBytes(of: UInt16(length), toByteOffset: try XCTUnwrap(MemoryLayout<dirent>.offset(of: \dirent.d_reclen)), as: UInt16.self)
        entry.storeBytes(of: UInt16(name.count), toByteOffset: try XCTUnwrap(MemoryLayout<dirent>.offset(of: \dirent.d_namlen)), as: UInt16.self)
        name.withUnsafeBytes { entry.advanced(by: nameOffset).copyMemory(from: $0.baseAddress!, byteCount: name.count) }
        let typed = entry.bindMemory(to: dirent.self, capacity: 1)

        XCTAssertEqual(NativeCrashContextFiles.name(of: UnsafePointer(typed)), "context-1.bin")
    }

    /// A run holds up to maxContextsPerRun contexts, enough to fill several readdir buffers.
    func testEntriesListsADirectoryLargerThanOneReaddirBuffer() throws {
        let names = (0..<300).map { _ in "\(UUID().uuidString.lowercased()).context" }
        for name in names { XCTAssertTrue(FileManager.default.createFile(atPath: root.appendingPathComponent(name).path, contents: nil)) }

        XCTAssertEqual(Set(try NativeCrashContextFiles.entries(root, maximum: 300)), Set(names))
    }

    func testNameRejectsInvalidUTF8() throws {
        let nameOffset = try XCTUnwrap(MemoryLayout<dirent>.offset(of: \dirent.d_name))
        var entry = dirent()
        entry.d_namlen = 2
        withUnsafeMutableBytes(of: &entry) { $0[nameOffset] = 0xC3; $0[nameOffset + 1] = 0x28 }

        XCTAssertNil(withUnsafePointer(to: &entry) { NativeCrashContextFiles.name(of: $0) })
    }
}
