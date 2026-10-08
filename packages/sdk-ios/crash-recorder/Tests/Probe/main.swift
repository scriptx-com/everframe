// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeCrashRecorder
import EFCRProbeNative
let args = CommandLine.arguments
func check(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() { fputs("ASSERTION: \(message)\n", stderr); exit(90) }
}
check(!EFCRIsEnabled(), "initial gate")
check(!EFCRSetEnabled(true), "cannot enable before installation")
let mode = args[1], directory = args[2]
if !mode.hasPrefix("ctx-") { check(EFCRProbeGate() == 0, "callback suppresses only when gate is closed") }
if mode.hasPrefix("ctx-") { check(!EFCRSetContextIdentifier(nil), "cannot publish before install") }
if mode == "invalid" {
    check(EFCRInstall(directory) == EFCRInstallInvalidDirectory, "invalid path")
    check(!EFCRIsEnabled(), "invalid install stays disabled")
    exit(0)
}
if mode == "terminal" {
    check(EFCRProbePoisonVendor(args[3]) == 0, "poison actual vendor singleton")
    check(EFCRInstall(directory) == EFCRInstallVendorFailure, "vendor failure")
    check(EFCRInstall(directory) == EFCRInstallVendorFailure, "terminal vendor failure")
    check(!EFCRSetEnabled(true), "failed install cannot enable")
    exit(0)
}
if mode == "background-install" {
    check(EFCRProbeInstallOffMain(directory) == Int32(EFCRInstallWrongThread.rawValue), "install off the main thread")
    check((try? FileManager.default.contentsOfDirectory(atPath: directory))?.isEmpty == true, "off-main install left no files")
    check(EFCRInstall(directory) == EFCRInstallSuccess, "install on the main thread")
    check(EFCRProbeEnableOffMain() == 0 && !EFCRIsEnabled(), "enable off the main thread")
    check(EFCRSetEnabled(true) && EFCRIsEnabled(), "enable on the main thread")
    check(EFCRProbeDisableOffMain() == 1 && !EFCRIsEnabled(), "disable off the main thread")
    check(EFCRSetEnabled(true) && EFCRIsEnabled(), "re-enable on the main thread")
    check(EFCRSetEnabled(false), "final disable")
    exit(0)
}
check(EFCRInstall(nil) == EFCRInstallInvalidDirectory, "nil path is recoverable validation failure")
check(EFCRInstall(directory) == EFCRInstallSuccess, "install")
check(!EFCRIsEnabled(), "installation returns disabled")
if mode.hasPrefix("ctx-") {
    let contextA = mode == "ctx-current" && args.count > 4 ? args[4] : "11111111-1111-4111-8111-111111111111"
    let contextB = "22222222-2222-4222-8222-222222222222"
    check(EFCRSetContextIdentifier(contextA), "publish A while disabled")
    switch mode {
    case "ctx-invalid":
        for value in ["", "../../outside", "11111111-1111-4111-8111-11111111111Z", "11111111-1111-4111-8111-111111111111x", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"] {
            check(!EFCRSetContextIdentifier(value), "invalid context preserves A")
        }
    case "ctx-current":
        check(EFCRSetEnabled(true), "enable A")
        check(!EFCRSetContextIdentifier(contextB), "cannot publish while enabled")
        check(!EFCRSetContextIdentifier(nil), "cannot clear while enabled")
    case "ctx-switched", "ctx-admitted":
        check(EFCRSetEnabled(true), "enable A")
        if mode == "ctx-admitted" { check(EFCRProbeAdmitContext() == 0, "synthetic admission before publication") }
        check(EFCRSetEnabled(false), "disable before publishing B")
        check(EFCRProbePublishOffMain(contextB) == 1, "publish B off the main thread")
    case "ctx-cleared": check(EFCRSetContextIdentifier(nil), "clear while disabled")
    case "ctx-admitted-empty":
        check(EFCRSetContextIdentifier(nil), "clear before admission")
        check(EFCRSetEnabled(true), "enable without context")
        check(EFCRProbeAdmitContext() == 0, "synthetic empty admission")
        check(EFCRSetEnabled(false), "disable after empty admission")
        check(EFCRSetContextIdentifier(contextB), "publish B after empty admission")
    case "ctx-capacity", "ctx-capacity-last":
        // A occupies the first slot;255 other immutable identifiers fill the budget.
        for index in 0..<255 {
            let identifier = String(format: "00000000-0000-0000-0000-%012x", index)
            check(EFCRSetContextIdentifier(identifier), "slot within budget")
            check(EFCRSetContextIdentifier(identifier), "duplicate consumes no slot")
        }
        // The fatal report, not a republication, shows which owner each rejection kept.
        check(!EFCRSetContextIdentifier(contextB), "capacity rejects a new identifier")
        if mode == "ctx-capacity" {
            check(EFCRSetContextIdentifier(contextA), "existing slot reusable after exhaustion")
            check(!EFCRSetContextIdentifier(contextB), "capacity still rejects a new identifier")
        }
    default: exit(93)
    }
    check(EFCRSetEnabled(true), "enable context probe")
    // Existing context probes default to Swift; record decoding also exercises ObjC and memory faults.
    if args.count > 3 {
        switch args[3] {
        case "objc": EFCRProbeObjCException()
        case "memory": EFCRProbeMemoryFault()
        case "swift": break
        default: exit(91)
        }
    }
    fatalError("EFCR synthetic context trap")
}
if mode == "state" {
    check(EFCRInstall(args[3]) == EFCRInstallAlreadyInstalled, "cannot replace owner")
    check(EFCRSetEnabled(true) && EFCRIsEnabled(), "enable")
    check(EFCRSetEnabled(false) && !EFCRIsEnabled(), "disable")
    check(EFCRSetEnabled(true) && EFCRIsEnabled(), "reenable")
    check(EFCRSetEnabled(false), "final disable")
    check(String(cString: EFCRVersion()).contains("2.6.0"), "version metadata")
    exit(0)
}
if mode != "disabled" && mode != "monitors-off" { check(EFCRSetEnabled(true), "enable fatal detector") }
if mode == "disabled-after" || mode == "reenabled" { check(EFCRSetEnabled(false), "disable fatal detector") }
if mode == "reenabled" { check(EFCRSetEnabled(true), "reenable fatal detector") }
// Move the report gate alone, so the gate and the install-time monitor disable are each proven.
if mode == "gate-closed" { EFCRProbeSetGate(false); check(!EFCRIsEnabled(), "gate closed while monitors run") }
if mode == "monitors-off" { EFCRProbeSetGate(true); check(EFCRIsEnabled(), "gate open while monitors are off") }
// An opt-out on another thread must close the gate and disable the monitors; reopening only
// the gate afterwards shows the monitors stayed off.
if mode == "disabled-off-main" {
    check(EFCRProbeDisableOffMain() == 1 && !EFCRIsEnabled(), "disable off the main thread")
    EFCRProbeSetGate(true); check(EFCRIsEnabled(), "gate reopened while monitors are off")
}
switch args[3] {
case "swift": fatalError("EFCR synthetic Swift trap")
case "objc": EFCRProbeObjCException()
case "memory": EFCRProbeMemoryFault()
case "leaf": EFCRProbeLeafFault()
case "overflow": EFCRProbeStackOverflow()
// abort() is outside the Mach exception mask, so only the signal monitor can record it.
case "signal": abort()
default: exit(91)
}
exit(92)
