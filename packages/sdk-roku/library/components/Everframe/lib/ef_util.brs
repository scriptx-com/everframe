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
