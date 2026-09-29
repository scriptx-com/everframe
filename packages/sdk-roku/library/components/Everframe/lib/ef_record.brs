' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Builds an EfRecord (the unit persisted in the registry queue) from a caught
' exception object or a plain string.

function EfR_FromException(e as dynamic, mechanism as string, handled as boolean) as object
    if e = invalid then e = { message: "" }
    if GetInterface(e, "ifString") <> invalid then e = { message: e }
    kind = "crash"
    if handled then kind = "error"
    rec = {
        v: 1,
        id: CreateObject("roDeviceInfo").GetRandomUUID(),
        t: EfU_NowMs(),
        kind: kind,
        mechanism: mechanism,
        handled: handled,
        fatal: not handled,
        exceptionType: EfF_ExceptionType(e.number),
        message: EfU_Truncate(e.message, 4096),
        frames: EfF_FromBacktrace(e.backtrace),
        appVersion: CreateObject("roAppInfo").GetVersion(),
        crumbs: []
    }
    return rec
end function
