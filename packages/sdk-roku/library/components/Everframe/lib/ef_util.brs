' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Small helpers shared by the library and the injected hook.

function EfU_NowMs() as longinteger
    dt = CreateObject("roDateTime")
    return (dt.AsSeconds() * 1000&) + dt.GetMilliseconds()
end function

function EfU_IsoFromMs(ms as dynamic) as string
    whole& = ms \ 1000&
    frac = ms - (whole& * 1000&)
    dt = CreateObject("roDateTime")
    dt.FromSeconds(CInt(whole&))
    return Left(dt.ToISOString(), 19) + "." + Right("00" + frac.ToStr(), 3) + "Z"
end function

function EfU_MsFromIso(iso as string) as longinteger
    dt = CreateObject("roDateTime")
    dt.FromISO8601String(iso)
    return dt.AsSeconds() * 1000&
end function

function EfU_Truncate(s as dynamic, n as integer) as string
    if s = invalid then return ""
    if Len(s) > n then return Left(s, n)
    return s
end function

function EfU_Tail(s as dynamic, n as integer) as string
    if s = invalid then return ""
    if Len(s) > n then return Right(s, n)
    return s
end function

function EfU_ReadOrInvalid(sec as object, key as string) as dynamic
    if not sec.Exists(key) then return invalid
    return sec.Read(key)
end function

' Scalar -> string for wire fields the protocol types as strings. Returns
' invalid for invalid and for non-scalar values (arrays, AAs, nodes).
function EfU_ScalarStr(v as dynamic) as dynamic
    if v = invalid then return invalid
    if GetInterface(v, "ifString") <> invalid then return v
    if GetInterface(v, "ifToStr") = invalid then return invalid
    t = type(v)
    if t = "roArray" or t = "roAssociativeArray" or t = "roSGNode" then return invalid
    return v.ToStr()
end function

' setUser input -> { id?, email?, displayName? } of strings, or invalid when
' nothing usable remains. Keys are bracket-assigned to keep displayName's case.
function EfU_NormalizeUser(u as dynamic) as dynamic
    if type(u) <> "roAssociativeArray" then return invalid
    user = {}
    for each k in ["id", "email", "displayName"]
        s = EfU_ScalarStr(u[k])
        if s <> invalid then user[k] = s
    end for
    if user.Count() = 0 then return invalid
    return user
end function

' Breadcrumb level: one of debug|info|warn|error (case-insensitive), else invalid.
function EfU_NormalizeLevel(l as dynamic) as dynamic
    if l = invalid or GetInterface(l, "ifString") = invalid then return invalid
    lower = LCase(l)
    if lower = "debug" or lower = "info" or lower = "warn" or lower = "error" then return lower
    return invalid
end function

' maxBreadcrumbs: integers are clamped to 1..50; anything else gets the default 50.
function EfU_MaxCrumbs(n as dynamic) as integer
    t = type(n)
    if t <> "Integer" and t <> "roInt" and t <> "LongInteger" and t <> "roLongInteger" then return 50
    if n < 1 then return 1
    if n > 50 then return 50
    return CInt(n)
end function
