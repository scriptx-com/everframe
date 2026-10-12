// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

public extension EverframeCrash {
    /// Preserve the initializer used before Android native evidence was added.
    init(causeChain: EverframeCrashCauseChain?, details: EverframeCrashDetails?, exceptionType: String,
         fatal: Bool?, fingerprint: String, frames: [EverframeFrame], handled: Bool,
         jsBundle: EverframeJSBundle?, jvm: EverframeJVMCrashMetadata?, mechanism: String,
         message: String, native: EverframeNativeCrashMetadata?, occurredAt: Date, threadName: String?) {
        self.init(androidNative: nil, causeChain: causeChain, details: details, exceptionType: exceptionType,
                  fatal: fatal, fingerprint: fingerprint, frames: frames, handled: handled, jsBundle: jsBundle,
                  jvm: jvm, mechanism: mechanism, message: message, native: native, occurredAt: occurredAt,
                  threadName: threadName)
    }

    /// Keep the prior generated helper symbol while retaining both native sidecars.
    @_disfavoredOverload
    func with(causeChain: EverframeCrashCauseChain?? = nil, details: EverframeCrashDetails?? = nil,
              exceptionType: String? = nil, fatal: Bool?? = nil, fingerprint: String? = nil,
              frames: [EverframeFrame]? = nil, handled: Bool? = nil, jsBundle: EverframeJSBundle?? = nil,
              jvm: EverframeJVMCrashMetadata?? = nil, mechanism: String? = nil, message: String? = nil,
              native: EverframeNativeCrashMetadata?? = nil, occurredAt: Date? = nil,
              threadName: String?? = nil) -> EverframeCrash {
        EverframeCrash(androidNative: self.androidNative, causeChain: causeChain ?? self.causeChain,
              details: details ?? self.details, exceptionType: exceptionType ?? self.exceptionType,
              fatal: fatal ?? self.fatal, fingerprint: fingerprint ?? self.fingerprint,
              frames: frames ?? self.frames, handled: handled ?? self.handled, jsBundle: jsBundle ?? self.jsBundle,
              jvm: jvm ?? self.jvm, mechanism: mechanism ?? self.mechanism, message: message ?? self.message,
              native: native ?? self.native, occurredAt: occurredAt ?? self.occurredAt,
              threadName: threadName ?? self.threadName)
    }

    /// Preserve the initializer used before optional native metadata was added.
    init(causeChain: EverframeCrashCauseChain?, details: EverframeCrashDetails?, exceptionType: String,
         fatal: Bool?, fingerprint: String, frames: [EverframeFrame], handled: Bool,
         jsBundle: EverframeJSBundle?, jvm: EverframeJVMCrashMetadata?, mechanism: String,
         message: String, occurredAt: Date, threadName: String?) {
        self.init(causeChain: causeChain, details: details, exceptionType: exceptionType, fatal: fatal,
                  fingerprint: fingerprint, frames: frames, handled: handled, jsBundle: jsBundle,
                  jvm: jvm, mechanism: mechanism, message: message, native: nil,
                  occurredAt: occurredAt, threadName: threadName)
    }

    /// Frozen callers keep their original helper and preserve the new sidecar.
    @_disfavoredOverload
    func with(causeChain: EverframeCrashCauseChain?? = nil, details: EverframeCrashDetails?? = nil,
              exceptionType: String? = nil, fatal: Bool?? = nil, fingerprint: String? = nil,
              frames: [EverframeFrame]? = nil, handled: Bool? = nil, jsBundle: EverframeJSBundle?? = nil,
              jvm: EverframeJVMCrashMetadata?? = nil, mechanism: String? = nil, message: String? = nil,
              occurredAt: Date? = nil, threadName: String?? = nil) -> EverframeCrash {
        EverframeCrash(androidNative: self.androidNative, causeChain: causeChain ?? self.causeChain, details: details ?? self.details,
              exceptionType: exceptionType ?? self.exceptionType, fatal: fatal ?? self.fatal,
              fingerprint: fingerprint ?? self.fingerprint, frames: frames ?? self.frames,
              handled: handled ?? self.handled, jsBundle: jsBundle ?? self.jsBundle, jvm: jvm ?? self.jvm,
              mechanism: mechanism ?? self.mechanism, message: message ?? self.message, native: self.native,
              occurredAt: occurredAt ?? self.occurredAt, threadName: threadName ?? self.threadName)
    }

    /// Preserve the generated initializer used immediately before optional causeChain was added.
    init(details: EverframeCrashDetails?, exceptionType: String, fatal: Bool?, fingerprint: String,
         frames: [EverframeFrame], handled: Bool, jsBundle: EverframeJSBundle?, jvm: EverframeJVMCrashMetadata?,
         mechanism: String, message: String, occurredAt: Date, threadName: String?) {
        self.init(causeChain: nil, details: details, exceptionType: exceptionType, fatal: fatal,
                  fingerprint: fingerprint, frames: frames, handled: handled, jsBundle: jsBundle,
                  jvm: jvm, mechanism: mechanism, message: message, occurredAt: occurredAt,
                  threadName: threadName)
    }

    /// Preserve the generated initializer used immediately before optional details were added.
    init(exceptionType: String, fatal: Bool?, fingerprint: String, frames: [EverframeFrame], handled: Bool,
         jsBundle: EverframeJSBundle?, jvm: EverframeJVMCrashMetadata?, mechanism: String, message: String,
         occurredAt: Date, threadName: String?) {
        self.init(causeChain: nil, details: nil, exceptionType: exceptionType, fatal: fatal, fingerprint: fingerprint,
                  frames: frames, handled: handled, jsBundle: jsBundle, jvm: jvm,
                  mechanism: mechanism, message: message, occurredAt: occurredAt, threadName: threadName)
    }

    /// Preserve the initializer used before optional JVM crash metadata was added.
    init(exceptionType: String, fatal: Bool?, fingerprint: String, frames: [EverframeFrame], handled: Bool,
         jsBundle: EverframeJSBundle?, mechanism: String, message: String, occurredAt: Date, threadName: String?) {
        self.init(causeChain: nil, details: nil, exceptionType: exceptionType, fatal: fatal, fingerprint: fingerprint,
                  frames: frames, handled: handled, jsBundle: jsBundle, jvm: nil,
                  mechanism: mechanism, message: message, occurredAt: occurredAt, threadName: threadName)
    }

    /// Preserve the initializer used before optional JS bundle identity was added.
    init(exceptionType: String, fatal: Bool?, fingerprint: String, frames: [EverframeFrame], handled: Bool,
         mechanism: String, message: String, occurredAt: Date, threadName: String?) {
        self.init(causeChain: nil, details: nil, exceptionType: exceptionType, fatal: fatal, fingerprint: fingerprint,
                  frames: frames, handled: handled, jsBundle: nil, jvm: nil, mechanism: mechanism,
                  message: message, occurredAt: occurredAt, threadName: threadName)
    }

    /// Preserve the initializer used before optional fatal classification was added.
    init(exceptionType: String, fingerprint: String, frames: [EverframeFrame], handled: Bool,
         mechanism: String, message: String, occurredAt: Date, threadName: String?) {
        self.init(causeChain: nil, details: nil, exceptionType: exceptionType, fatal: nil, fingerprint: fingerprint,
                  frames: frames, handled: handled, jsBundle: nil, jvm: nil, mechanism: mechanism, message: message,
                  occurredAt: occurredAt, threadName: threadName)
    }

    /// Preserve the generated helper used immediately before optional causeChain was added.
    @_disfavoredOverload
    func with(
        details: EverframeCrashDetails?? = nil,
        exceptionType: String? = nil,
        fatal: Bool?? = nil,
        fingerprint: String? = nil,
        frames: [EverframeFrame]? = nil,
        handled: Bool? = nil,
        jsBundle: EverframeJSBundle?? = nil,
        jvm: EverframeJVMCrashMetadata?? = nil,
        mechanism: String? = nil,
        message: String? = nil,
        occurredAt: Date? = nil,
        threadName: String?? = nil
    ) -> EverframeCrash {
        EverframeCrash(androidNative: self.androidNative, causeChain: self.causeChain, details: details ?? self.details,
              exceptionType: exceptionType ?? self.exceptionType, fatal: fatal ?? self.fatal,
              fingerprint: fingerprint ?? self.fingerprint, frames: frames ?? self.frames,
              handled: handled ?? self.handled, jsBundle: jsBundle ?? self.jsBundle,
              jvm: jvm ?? self.jvm, mechanism: mechanism ?? self.mechanism,
              message: message ?? self.message, native: self.native, occurredAt: occurredAt ?? self.occurredAt,
              threadName: threadName ?? self.threadName)
    }
}
