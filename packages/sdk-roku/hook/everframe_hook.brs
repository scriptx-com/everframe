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
        ef = Everframe__Node()
        if ef <> invalid then
            rec.crumbs = ef.callFunc("getCrumbs", invalid)
            user = ef.callFunc("getUser", invalid)
            if user <> invalid then rec.user = user
        end if
        EfQ_Put(CreateObject("roRegistrySection", "Everframe"), rec)
        if ef <> invalid then ef.callFunc("kick", invalid)
    catch ignored
        print "[everframe] could not record error"
    end try
end sub

sub Everframe_Crumb(kind as string, message as string, data as dynamic)
    try
        ef = Everframe__Node()
        if ef <> invalid then ef.callFunc("addBreadcrumb", { kind: kind, message: message, data: data })
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
