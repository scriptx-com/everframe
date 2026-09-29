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

' Roku OS timestamps carry milliseconds ("2026-09-29T12:14:40.403Z"); the
' device's FromISO8601String does not parse the fraction reliably, so parse the
' whole-second part and add the milliseconds back.
function EfU_MsFromIso(iso as string) as longinteger
    base = iso
    frac& = 0
    hit = CreateObject("roRegex", "^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,3})\d*(Z|[+-]\d{2}:?\d{2})?$", "").Match(iso)
    if hit.Count() >= 3 then
        zone = "Z"
        if hit.Count() >= 4 and hit[3] <> "" then zone = hit[3]
        base = hit[1] + zone
        digits = Left(hit[2] + "00", 3)
        frac& = Val(digits, 10)
    end if
    dt = CreateObject("roDateTime")
    dt.FromISO8601String(base)
    return (dt.AsSeconds() * 1000&) + frac&
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

function EfU_IsNum(v as dynamic) as boolean
    t = type(v)
    return t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger" or t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble"
end function

' The reporter persists its latest memory reading in "mem" as
' {"percent":NN,"limitMb":NNN,"t":ms}. Returns { percent, limitMb? } when that
' reading is within 5 minutes of atMs, else invalid (no reading, garbled, or
' left over from an older session).
function EfU_ReadMem(sec as object, atMs as dynamic) as dynamic
    raw = EfU_ReadOrInvalid(sec, "mem")
    if raw = invalid or raw = "" then return invalid
    mem = ParseJson(raw)
    if type(mem) <> "roAssociativeArray" then return invalid
    if not EfU_IsNum(mem.percent) or not EfU_IsNum(mem.t) or not EfU_IsNum(atMs) then return invalid
    if Abs(atMs - mem.t) > 300000 then return invalid
    out = { "percent": mem.percent }
    if EfU_IsNum(mem.limitMb) then out["limitMb"] = mem.limitMb
    return out
end function

' Roku shares the registry between every channel signed with the same
' developer key, so the section carries the channel ID ("dev" when
' sideloaded): one channel never drains another's reports.
function EfU_SectionName() as string
    return "Everframe_" + CreateObject("roAppInfo").GetID()
end function

function EfU_Section() as object
    return CreateObject("roRegistrySection", EfU_SectionName())
end function

' start({ enabled: false }) sets "disabled"; the hook and captureException
' then record nothing until a start() without it.
function EfU_IsDisabled(sec as object) as boolean
    return sec.Exists("disabled")
end function

' Exit codes that end a session abnormally (reported on the next launch).
' Shared with the injected hook, which keeps an unreported one in
' "pendingExit" rather than replace it with a normal exit.
function EfU_IsAbnormalExit(code as dynamic) as boolean
    if code = invalid or GetInterface(code, "ifString") = invalid then return false
    known = {
        "EXIT_BRIGHTSCRIPT_CRASH": true,
        "EXIT_BRIGHTSCRIPT_TIMEOUT": true,
        "EXIT_BRIGHTSCRIPT_STOP": true,
        "EXIT_BRIGHTSCRIPT_UNK_FUNC": true,
        "EXIT_CHANNEL_MEM_LIMIT_FG": true,
        "EXIT_CHANNEL_MEM_LIMIT_BG": true,
        "EXIT_OUT_OF_MEMORY": true,
        "EXIT_AM_LOWRESOURCE": true,
        "EXIT_SYSTEM_KILL": true
    }
    if known.DoesExist(code) then return true
    return Instr(1, UCase(code), "CRASH") > 0
end function

' This session's app version/build as JSON { "v", "b"? }.
function EfU_VersionJson() as string
    ai = CreateObject("roAppInfo")
    out = { "v": ai.GetVersion() }
    build = ai.GetValue("build_version")
    if build <> invalid and build <> "" then out["b"] = build
    return FormatJson(out)
end function

' start(): the previous session's "ver" becomes "prevVer" (read by the exit
' check, which runs after start), then "ver" records this session's.
sub EfU_RotateVersion(sec as object)
    if sec.Exists("ver") then sec.Write("prevVer", sec.Read("ver")) else sec.Delete("prevVer")
    sec.Write("ver", EfU_VersionJson())
    sec.Flush()
end sub
