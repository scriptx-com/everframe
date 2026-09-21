// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Plain-ObjC public interface for the @traceitx/react-native TurboModule.
//
// IMPORTANT — KEEP THIS FILE FREE OF C++ INCLUDES.
//
// Under `use_frameworks!` (which our spm_dependency setup mandates), CocoaPods
// builds the TraceItX pod as a framework with an auto-generated umbrella
// header that re-imports every `public_header_files` entry. The umbrella is
// processed in plain-ObjC context. If we re-export the codegen
// `<TraceItXSpec/TraceItXSpec.h>` here (which has
// `#error This file must be compiled as Obj-C++`), every consumer of the
// framework — including unrelated pods like RCTAppDependencyProvider —
// fails to compile.
//
// The `<NativeTraceItXSpec>` protocol conformance therefore lives in a private
// class extension in `TraceItXModule.mm` (which IS compiled as ObjC++).
// RN's TurboModule registry doesn't need the conformance to be public — it
// resolves the class via `RCT_EXPORT_MODULE(TraceItX)`, locates the
// `<NativeTraceItXSpec>` conformance at runtime via Objective-C method
// resolution, and binds the JSI methods through codegen.

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
// Plan 06.2-11: TraceItXEventEmitter (Swift) inherits from RCTEventEmitter.
// CocoaPods generates a `TraceItXRN-Swift.h` that declares the @interface
// for the Swift class — that declaration needs the full RCTEventEmitter
// interface visible at the point the umbrella header is processed.
// RCTEventEmitter.h is plain Objective-C (no C++), so it's safe to expose
// through the public umbrella without violating the "no C++ in this header"
// rule at the top of this file.
#import <React/RCTEventEmitter.h>

@interface TraceItXModule : NSObject <RCTBridgeModule>
@end
