' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Injected into your channel by `everframe-roku instrument`. Do not edit:
' it is regenerated on every build. Requires ef_util, ef_frames, ef_record and
' ef_queue (copied alongside by the CLI).

sub Everframe_OnError(e as object, entry as string, isTask as boolean)
    try
        rec = EfR_FromException(e, "try-catch", false)
        rec.context = EfU_Truncate(entry, 256)
        rec.thread = Everframe__Thread(isTask)
        sec = CreateObject("roRegistrySection", "Everframe")
        ' Latest reading the SDK reporter persisted (invalid when none or stale).
        mem = EfU_ReadMem(sec, rec.t)
        if mem <> invalid then rec.memory = mem
        ef = Everframe__Node()
        if ef <> invalid then
            rec.crumbs = ef.callFunc("getCrumbs", invalid)
            user = ef.callFunc("getUser", invalid)
            if user <> invalid then rec.user = user
            route = ef.callFunc("getScreen", invalid)
            if route <> invalid then rec.route = route
        end if
        EfQ_Put(sec, rec)
        if ef <> invalid then ef.callFunc("kick", invalid)
    catch ignored
        print "[everframe] could not record error"
    end try
end sub

' Call first thing in Main() (the instrumented build does). Roku returns the
' previous launch's exit record only to the channel's own code: the same call
' from the Everframe ComponentLibrary always gets EXIT_UNKNOWN with no
' timestamp. The record is stored in registry "Everframe"/"pendingExit"; the
' library's reporter takes it from there. roAppManager is not available on the
' render thread, so this must run in Main (or a Task), never in a component.
sub Everframe_RecordLastExit()
    try
        am = CreateObject("roAppManager")
        if am <> invalid and FindMemberFunction(am, "GetLastExitInfo") <> invalid then
            Everframe__StoreExit(am.GetLastExitInfo())
        end if
    catch ignored
    end try
end sub

sub Everframe__StoreExit(info as dynamic)
    try
        if type(info) = "roAssociativeArray" then
            if Everframe__IsStr(info["exit_code"]) and Everframe__IsStr(info["timestamp"]) then
                sec = CreateObject("roRegistrySection", "Everframe")
                sec.Write("pendingExit", FormatJson(info))
                sec.Flush()
            end if
        end if
    catch ignored
    end try
end sub

function Everframe__IsStr(v as dynamic) as boolean
    return v <> invalid and GetInterface(v, "ifString") <> invalid
end function

sub Everframe_Crumb(kind as string, message as string, data as dynamic)
    try
        ef = Everframe__Node()
        if ef <> invalid then ef.callFunc("addBreadcrumb", { kind: kind, message: message, data: data })
    catch ignored
    end try
end sub

sub Everframe_KeyCrumb(key as dynamic, press as dynamic)
    try
        if type(press) = "roBoolean" or type(press) = "Boolean" then
            if press then Everframe_Crumb("tap", "key " + key.ToStr(), invalid)
        end if
    catch ignored
    end try
end sub

' Called on the init() signature line of components matched by
' `everframe-roku instrument --screens` (default *Screen, *View, *Page). Sets
' the current screen on the Everframe node; a no-op before start().
sub Everframe_Screen(name as dynamic)
    try
        ef = Everframe__Node()
        if ef <> invalid then ef.callFunc("setScreen", name)
    catch ignored
    end try
end sub

function Everframe__Node() as dynamic
    if type(m.global) <> "roSGNode" then return invalid
    ef = m.global.everframe
    if type(ef) <> "roSGNode" then return invalid
    return ef
end function

function Everframe__Thread(isTask as boolean) as string
    if type(m.top) <> "roSGNode" then return "main"
    if isTask then return m.top.subtype()
    return "render"
end function
