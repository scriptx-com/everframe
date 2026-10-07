// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

// Only this whitelist can cross from the vendor document into normalization.
struct NativeCrashVendorRecord: Decodable {
    struct Header: Decodable {
        let version: String, type: String, id: String
        let run_id: String?
        let timestamp: UInt64
    }
    struct User: Decodable { let everframe_context_id: String? }
    struct Crash: Decodable {
        let error: Fault
        let threads: Threads
        /// NSException origin (callStackReturnAddresses). A malformed value counts as absent.
        let last_exception_backtrace: Backtrace?
        let lastExceptionBacktraceMalformed: Bool
        enum CodingKeys: String, CodingKey { case error, threads, last_exception_backtrace }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            error = try c.decode(Fault.self, forKey: .error)
            threads = try c.decode(Threads.self, forKey: .threads)
            last_exception_backtrace = try? c.decode(Backtrace.self, forKey: .last_exception_backtrace)
            lastExceptionBacktraceMalformed = c.contains(.last_exception_backtrace) && last_exception_backtrace == nil
        }
    }
    struct Fault: Decodable {
        struct Mach: Decodable {
            let exception: Int32
            let exception_name: String?
            let code: IntegerBits?
            let subcode: IntegerBits?
        }
        struct Signal: Decodable { let signal: Int32; let name: String?; let code: Int32? }
        struct Exception: Decodable { let name: String? }
        let type: String
        let is_fatal: Bool
        let is_clean_exit: Bool?
        let address: UInt64?
        let reason: String?
        let mach: Mach?
        let signal: Signal?
        let nsexception: Exception?
    }
    struct IntegerBits: Decodable {
        let value: UInt64
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let unsigned = try? c.decode(UInt64.self) { value = unsigned }
            else { value = UInt64(bitPattern: try c.decode(Int64.self)) }
        }
    }
    struct Thread: Decodable {
        let index: Int
        let crashed: Bool
        let backtrace: Backtrace?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            index = try c.decode(Int.self, forKey: .index)
            crashed = try c.decode(Bool.self, forKey: .crashed)
            backtrace = crashed ? (try? c.decode(Backtrace.self, forKey: .backtrace)) : nil
        }
        enum CodingKeys: String, CodingKey { case index, crashed, backtrace }
    }
    struct Threads: Decodable {
        let values: [Thread]
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            // The pinned recorder captures at most 1000 threads and always keeps the crashed one.
            guard (c.count ?? 0) <= 1000 else { throw NativeCrashRecordDecoder.Failure.collectionLimit }
            var values: [Thread] = []
            while !c.isAtEnd {
                guard values.count < 1000 else { throw NativeCrashRecordDecoder.Failure.collectionLimit }
                values.append(try c.decode(Thread.self))
            }
            self.values = values
        }
    }
    struct Backtrace: Decodable { let contents: Frames; let skipped: Int? }
    struct Frames: Decodable {
        let values: [Frame]
        let incomplete: Bool
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer(), values: [Frame] = []
            var incomplete = false
            for _ in 0..<256 {
                if c.isAtEnd { break }
                let entry = try c.superDecoder()
                if let value = try? Frame(from: entry) { values.append(value) }
                else { incomplete = true }
            }
            self.values = values
            self.incomplete = incomplete || !c.isAtEnd
        }
    }
    struct Frame: Decodable {
        let instruction_addr: UInt64
        let object_addr: UInt64?
        let object_uuid: String?
        let symbol_name: String?
        let associationMalformed: Bool
        enum CodingKeys: String, CodingKey { case instruction_addr, object_addr, object_uuid, symbol_name }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            instruction_addr = try c.decode(UInt64.self, forKey: .instruction_addr)
            object_addr = try? c.decode(UInt64.self, forKey: .object_addr)
            object_uuid = try? c.decode(String.self, forKey: .object_uuid)
            symbol_name = try? c.decode(String.self, forKey: .symbol_name)
            associationMalformed = (c.contains(.object_addr) && object_addr == nil)
                || (c.contains(.object_uuid) && object_uuid == nil)
        }
    }
    struct Image: Decodable {
        let image_addr: UInt64, image_size: UInt64
        let image_vmaddr: UInt64?
        let uuid: String, name: String
        let cpu_type: Int32, cpu_subtype: Int32
    }
    struct Images: Decodable {
        /// Decodable entries with their source position. Processes can load more than a thousand
        /// images, so every entry within the input byte limit is scanned; only referenced ones are emitted.
        let values: [(index: Int, image: Image)]
        let skipped: Bool
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer(), values: [(index: Int, image: Image)] = [], skipped = false
            while !c.isAtEnd {
                let index = c.currentIndex
                if let image = try? Image(from: c.superDecoder()) { values.append((index, image)) } else { skipped = true }
            }
            self.values = values; self.skipped = skipped
        }
    }
    let report: Header
    let user: User?
    let crash: Crash
    let binary_images: Images?
}
