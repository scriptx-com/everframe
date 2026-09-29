' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX

' roAppManager is a MAIN/TASK-only component: creating it on the render thread
' fails, so the lab reads the previous exit info here, once, and hands the
' summary back through a field.
sub init()
    m.top.functionName = "readExitInfo"
end sub

sub readExitInfo()
    m.top.summary = ExitInfoSummary()
end sub

function ExitInfoSummary() as string
    am = CreateObject("roAppManager")
    if am = invalid then return "n/a"
    if FindMemberFunction(am, "GetLastExitInfo") = invalid then return "n/a (Roku OS < 13)"
    info = am.GetLastExitInfo()
    if type(info) <> "roAssociativeArray" then return "none"
    code = info.exit_code
    if code = invalid then return "none"
    text = code.ToStr()
    ts = info.timestamp
    if ts <> invalid then text = text + " at " + ts.ToStr()
    return text
end function
