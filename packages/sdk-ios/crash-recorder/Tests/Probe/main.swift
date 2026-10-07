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
check(EFCRProbeGate() == 0, "callback suppresses only when gate is closed")
let mode = args[1], directory = args[2]
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
    check(EFCRSetEnabled(false), "final disable")
    exit(0)
}
check(EFCRInstall(nil) == EFCRInstallInvalidDirectory, "nil path is recoverable validation failure")
check(EFCRInstall(directory) == EFCRInstallSuccess, "install")
check(!EFCRIsEnabled(), "installation returns disabled")
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
