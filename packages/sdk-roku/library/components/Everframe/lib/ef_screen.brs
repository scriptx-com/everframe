' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Current screen, sent as the report's context.route. The Everframe node keeps
' it in memory (setScreen / getScreen) and persists it to registry
' "Everframe"/"screen" on every change. start() rotates "screen" to
' "prevScreen" (like crumbs -> prevCrumbs), and the reporter attaches
' "prevScreen" to the next-launch exit-info record, then deletes it.
'
' Registry budget: "screen" and "prevScreen" are at most 128 chars each.

function EfS_MaxChars() as integer
    return 128
end function

' Screen name -> trimmed string of at most 128 chars, or invalid for invalid,
' non-scalar or blank input. Numbers and booleans become strings.
function EfS_Normalize(name as dynamic) as dynamic
    s = EfU_ScalarStr(name)
    if s = invalid then return invalid
    s = s.Trim()
    if s = "" then return invalid
    return Left(s, EfS_MaxChars())
end function

' The navigation breadcrumb for a screen change ("from" only when known).
function EfS_Crumb(prev as dynamic, name as string) as object
    data = { "to": name }
    if prev <> invalid then data["from"] = prev
    return { kind: "navigation", message: "screen: " + name, data: data }
end function

sub EfS_Persist(sec as object, name as string)
    sec.Write("screen", name)
    sec.Flush()
end sub

' Moves the last session's "screen" to "prevScreen" and clears "screen". With
' no "screen", a stale "prevScreen" is dropped so it can never be attached to a
' later, unrelated exit.
sub EfS_Rotate(sec as object)
    if sec.Exists("screen") then
        sec.Write("prevScreen", sec.Read("screen"))
        sec.Delete("screen")
    else if sec.Exists("prevScreen") then
        sec.Delete("prevScreen")
    end if
    sec.Flush()
end sub

' The previous session's screen, or invalid. Deleted either way: it belongs to
' exactly one exit.
function EfS_TakePrev(sec as object) as dynamic
    if not sec.Exists("prevScreen") then return invalid
    raw = sec.Read("prevScreen")
    sec.Delete("prevScreen")
    sec.Flush()
    return EfS_Normalize(raw)
end function
