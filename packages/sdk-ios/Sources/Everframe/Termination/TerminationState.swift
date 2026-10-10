// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import Darwin
import MachO

/// One fixed 4096-byte little-endian record per crash run. Each field has exactly one writer and
/// every write is an aligned 8-byte store into a MAP_SHARED mapping: no syscall, lock or disk I/O
/// after creation. The kernel keeps the dirty page across SIGKILL; the next process reads it.
/// Only a kernel panic or power loss loses it, and either changes the boot time.
enum TerminationLayout {
    static let fileName = "termination.state", size = 4096, textBytes = 64
    static let magic: UInt64 = 0x3130_4D52_4554_4645 // "EFTERM01" in little-endian byte order
    static let version: UInt64 = 1
    /// An unsampled size. Zero is a real reading (no headroom left).
    static let unknown = UInt64.max
    static let zeroUUID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    // Header: native-crash worker, once, before any other writer exists.
    static let magicAt = 0, versionAt = 8, launchIDAt = 16, executableUUIDAt = 32, bootTimeAt = 48, startedAt = 56
    static let osVersionAt = 64, appVersionAt = 128, appBuildAt = 192
    // Main thread.
    static let appStateAt = 256, stateChangedAt = 264, warningsAt = 272, lastWarningAt = 280, mainSeenAt = 288, terminateAt = 296
    // NativeCrashRuntime.lock holder.
    static let armedAt = 320, contextIDAt = 328
    // Termination tracker queue.
    static let sampledAt = 384, sampleUptimeAt = 392, footprintAt = 400, availableAt = 408, thermalAt = 416
    static let pressureAt = 424, pressureChangedAt = 432, stallAt = 440, debuggerAt = 448
    // atexit handler.
    static let exitAt = 512
}

enum TerminationAppState: UInt64, Sendable { case unknown = 0, launching, active, inactive, background }
enum TerminationPressure: UInt64, Sendable { case normal = 0, warning, critical }

struct TerminationIdentity: Equatable, Sendable {
    var appVersion: String, appBuild: String, executableUUID: UUID?, osVersion: String, bootTime: Int64
    static func current(bundle: Bundle = .main) -> TerminationIdentity {
        TerminationIdentity(appVersion: bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            appBuild: bundle.infoDictionary?["CFBundleVersion"] as? String ?? "",
            executableUUID: TerminationSystem.executableUUID(),
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString, bootTime: TerminationSystem.bootTime())
    }
}

enum TerminationSystem {
    /// Compared locally only (SystemBootTime 35F9.1, already declared); never sent.
    static func bootTime() -> Int64 {
        var boot = timeval(), size = MemoryLayout<timeval>.stride, mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
        return sysctl(&mib, 2, &boot, &size, nil, 0) == 0 ? Int64(boot.tv_sec) : 0
    }
    static func debuggerAttached() -> Bool {
        var info = kinfo_proc(), size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        return sysctl(&mib, 4, &info, &size, nil, 0) == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
    }
    /// dyld image 0 is the main executable. A rebuild changes LC_UUID even when the build number does not.
    static func executableUUID() -> UUID? {
        guard let header = _dyld_get_image_header(0), header.pointee.magic == UInt32(MH_MAGIC_64) else { return nil }
        var cursor = UnsafeRawPointer(header).advanced(by: MemoryLayout<mach_header_64>.size)
        for _ in 0..<header.pointee.ncmds {
            let command = cursor.loadUnaligned(as: load_command.self)
            if command.cmd == UInt32(LC_UUID) { return UUID(uuid: cursor.loadUnaligned(as: uuid_command.self).uuid) }
            guard command.cmdsize >= UInt32(MemoryLayout<load_command>.size) else { return nil }
            cursor = cursor.advanced(by: Int(command.cmdsize))
        }
        return nil
    }
    static func uptimeMs() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1_000_000 }
    static func wallMs(_ date: Date) -> UInt64 {
        let ms = (date.timeIntervalSince1970 * 1000).rounded()
        return ms.isFinite && ms > 0 ? UInt64(min(ms, 9_007_199_254_740_991)) : 0
    }
}

final class TerminationStateFile: @unchecked Sendable {
    enum Failure: Error { case io }
    let url: URL
    private let base: UnsafeMutableRawPointer
    private init(url: URL, base: UnsafeMutableRawPointer) { self.url = url; self.base = base }
    deinit { munmap(base, TerminationLayout.size) }

    /// Worker only. Exclusive create, never follows links, mode 0600, zero-filled.
    static func create(at url: URL) throws -> TerminationStateFile {
        let fd = open(url.path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Failure.io }
        defer { close(fd) }
        guard fchmod(fd, 0o600) == 0, ftruncate(fd, off_t(TerminationLayout.size)) == 0 else {
            unlink(url.path); throw Failure.io
        }
        let mapped = mmap(nil, TerminationLayout.size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
        guard let mapped, mapped != MAP_FAILED else { unlink(url.path); throw Failure.io }
        return TerminationStateFile(url: url, base: mapped)
    }
    func store(_ value: UInt64, at offset: Int) { base.storeBytes(of: value.littleEndian, toByteOffset: offset, as: UInt64.self) }
    func store(_ date: Date, at offset: Int) { store(TerminationSystem.wallMs(date), at: offset) }
    private func store(_ uuid: UUID, at offset: Int) {
        withUnsafeBytes(of: uuid.uuid) { base.advanced(by: offset).copyMemory(from: $0.baseAddress!, byteCount: 16) }
    }
    /// At most 63 UTF-8 bytes, cut on a character boundary, NUL-terminated.
    private func store(text: String, at offset: Int) {
        var bytes = Array(text.utf8)
        if bytes.count >= TerminationLayout.textBytes {
            var end = TerminationLayout.textBytes - 1
            while end > 0, bytes[end] & 0xC0 == 0x80 { end -= 1 }
            bytes = Array(bytes[..<end])
        }
        bytes += [UInt8](repeating: 0, count: TerminationLayout.textBytes - bytes.count)
        bytes.withUnsafeBytes { base.advanced(by: offset).copyMemory(from: $0.baseAddress!, byteCount: TerminationLayout.textBytes) }
    }
    /// Worker, once, before the runtime can arm or the tracker can start. Magic last.
    func writeHeader(launchID: UUID, identity: TerminationIdentity, startedAt: Date) {
        store(launchID, at: TerminationLayout.launchIDAt)
        store(identity.executableUUID ?? TerminationLayout.zeroUUID, at: TerminationLayout.executableUUIDAt)
        store(UInt64(bitPattern: identity.bootTime), at: TerminationLayout.bootTimeAt)
        store(startedAt, at: TerminationLayout.startedAt)
        store(text: identity.osVersion, at: TerminationLayout.osVersionAt)
        store(text: identity.appVersion, at: TerminationLayout.appVersionAt)
        store(text: identity.appBuild, at: TerminationLayout.appBuildAt)
        store(TerminationLayout.unknown, at: TerminationLayout.footprintAt)
        store(TerminationLayout.unknown, at: TerminationLayout.availableAt)
        store(TerminationLayout.version, at: TerminationLayout.versionAt)
        store(TerminationLayout.magic, at: TerminationLayout.magicAt)
    }
    /// NativeCrashRuntime.lock holder only. Identifier first, flag last; disarm clears the flag first.
    func arm(contextID: UUID) { store(contextID, at: TerminationLayout.contextIDAt); store(1, at: TerminationLayout.armedAt) }
    func disarm() { store(0, at: TerminationLayout.armedAt) }
}

struct TerminationRunRecord: Equatable, Sendable {
    enum Failure: Error { case invalid }
    var launchID: UUID, identity: TerminationIdentity, startedAt: Date
    var appState: TerminationAppState = .unknown, stateChangedAt: Date?
    var memoryWarnings = 0, lastWarningAt: Date?, terminateNotified = false
    var armed = false, contextID: UUID?
    var sampledAt: Date?, footprintBytes: UInt64?, availableBytes: UInt64?, thermalState = 0
    var pressure: TerminationPressure = .normal, pressureChangedAt: Date?, mainStallMs: UInt64 = 0
    var debuggerSeen = false, exitCalled = false
    /// The latest wall time any writer proved the process alive.
    var lastSeenAt: Date {
        [startedAt, stateChangedAt, sampledAt, lastWarningAt, pressureChangedAt].compactMap { $0 }.max() ?? startedAt
    }

    init(launchID: UUID, identity: TerminationIdentity, startedAt: Date) {
        self.launchID = launchID; self.identity = identity; self.startedAt = startedAt
    }
    init(bytes input: Data) throws {
        guard input.count == TerminationLayout.size else { throw Failure.invalid }
        let bytes = Data(input)   // zero-based indices even for a slice
        func u64(_ offset: Int) -> UInt64 { bytes.withUnsafeBytes { UInt64(littleEndian: $0.loadUnaligned(fromByteOffset: offset, as: UInt64.self)) } }
        func date(_ offset: Int) -> Date? { let ms = u64(offset); return ms == 0 ? nil : Date(timeIntervalSince1970: Double(ms) / 1000) }
        func size(_ offset: Int) -> UInt64? { let value = u64(offset); return value == TerminationLayout.unknown ? nil : value }
        func uuid(_ offset: Int) -> UUID? {
            let raw = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: uuid_t.self) }
            let value = UUID(uuid: raw); return value == TerminationLayout.zeroUUID ? nil : value
        }
        func text(_ offset: Int) -> String {
            let slice = bytes[offset..<(offset + TerminationLayout.textBytes)]
            return String(decoding: slice.prefix { $0 != 0 }, as: UTF8.self)
        }
        guard u64(TerminationLayout.magicAt) == TerminationLayout.magic, u64(TerminationLayout.versionAt) == TerminationLayout.version,
              let launchID = uuid(TerminationLayout.launchIDAt), let startedAt = date(TerminationLayout.startedAt),
              let appState = TerminationAppState(rawValue: u64(TerminationLayout.appStateAt)),
              let pressure = TerminationPressure(rawValue: u64(TerminationLayout.pressureAt)) else { throw Failure.invalid }
        self.init(launchID: launchID, identity: TerminationIdentity(appVersion: text(TerminationLayout.appVersionAt),
            appBuild: text(TerminationLayout.appBuildAt), executableUUID: uuid(TerminationLayout.executableUUIDAt),
            osVersion: text(TerminationLayout.osVersionAt), bootTime: Int64(bitPattern: u64(TerminationLayout.bootTimeAt))), startedAt: startedAt)
        self.appState = appState; stateChangedAt = date(TerminationLayout.stateChangedAt)
        memoryWarnings = Int(min(u64(TerminationLayout.warningsAt), 1_000_000)); lastWarningAt = date(TerminationLayout.lastWarningAt)
        terminateNotified = u64(TerminationLayout.terminateAt) != 0
        armed = u64(TerminationLayout.armedAt) == 1; contextID = uuid(TerminationLayout.contextIDAt)
        sampledAt = date(TerminationLayout.sampledAt); footprintBytes = size(TerminationLayout.footprintAt)
        availableBytes = size(TerminationLayout.availableAt); thermalState = Int(min(u64(TerminationLayout.thermalAt), 3))
        self.pressure = pressure; pressureChangedAt = date(TerminationLayout.pressureChangedAt)
        mainStallMs = min(u64(TerminationLayout.stallAt), 86_400_000); debuggerSeen = u64(TerminationLayout.debuggerAt) != 0
        exitCalled = u64(TerminationLayout.exitAt) != 0
    }
}
