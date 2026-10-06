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
if mode != "disabled" { check(EFCRSetEnabled(true), "enable fatal detector") }
if mode == "disabled-after" || mode == "reenabled" { check(EFCRSetEnabled(false), "disable fatal detector") }
if mode == "reenabled" { check(EFCRSetEnabled(true), "reenable fatal detector") }
switch args[3] {
case "swift": fatalError("EFCR synthetic Swift trap")
case "objc": EFCRProbeObjCException()
case "memory": EFCRProbeMemoryFault()
default: exit(91)
}
exit(92)
