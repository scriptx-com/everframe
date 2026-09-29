' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Path B: turn roAppManager.GetLastExitInfo() (Roku OS 13.0+) into a record.
' Roku returns the record only to the channel's own code, never to this
' ComponentLibrary, so the channel's Main() stores it in registry "Everframe"/
' "pendingExit" (Everframe_RecordLastExit in the hook, or the README snippet)
' and the reporter takes it with EfX_TakePending. GetLastExitInfo keeps
' returning the same exit until the next one, so the handled timestamp is
' remembered in "lastExitTs".

function EfX_IsAbnormal(code as string) as boolean
    known = {
        "EXIT_BRIGHTSCRIPT_CRASH": true,
        "EXIT_CHANNEL_MEM_LIMIT_FG": true,
        "EXIT_CHANNEL_MEM_LIMIT_BG": true,
        "EXIT_OUT_OF_MEMORY": true,
        "EXIT_AM_LOWRESOURCE": true,
        "EXIT_SYSTEM_KILL": true
    }
    if known.DoesExist(code) then return true
    return Instr(1, UCase(code), "CRASH") > 0
end function

function EfX_Meta(info as object) as object
    meta = { "exitCode": info.exit_code }
    if info.mem_limit <> invalid then meta["memLimitMb"] = info.mem_limit
    if info.app_state <> invalid then meta["appState"] = info.app_state
    if info.media_player_state <> invalid then meta["mediaPlayerState"] = info.media_player_state
    if info.console_log <> invalid and info.console_log <> "" then meta["consoleLog"] = EfU_Tail(info.console_log, 1024)
    return meta
end function

function EfX_ToRecord(info as object) as object
    meta = EfX_Meta(info)
    rec = {
        v: 1,
        id: CreateObject("roDeviceInfo").GetRandomUUID(),
        t: EfU_MsFromIso(info.timestamp),
        kind: "exit",
        mechanism: "exit-info",
        handled: false,
        fatal: true,
        "exceptionType": info.exit_code,
        message: "App exited: " + info.exit_code,
        frames: [],
        thread: "main",
        "appVersion": CreateObject("roAppInfo").GetVersion(),
        crumbs: [],
        "exitInfo": meta
    }
    parsed = EfF_ParseConsoleLog(info.console_log)
    if parsed <> invalid then
        rec["exceptionType"] = EfF_ExceptionType(parsed.number)
        rec.message = parsed.message
        rec.frames = parsed.frames
    end if
    return rec
end function

' Returns the record Main() stored in "pendingExit" (an AA) and deletes the
' key, or invalid when there is none or it does not parse to an object.
function EfX_TakePending(sec as object) as dynamic
    if not sec.Exists("pendingExit") then return invalid
    raw = sec.Read("pendingExit")
    sec.Delete("pendingExit")
    sec.Flush()
    if raw = "" then return invalid
    info = ParseJson(raw)
    if type(info) <> "roAssociativeArray" then return invalid
    return info
end function

' The crumbs the previous session persisted (Everframe start() rotated them to
' "prevCrumbs"), parsed, or [] when none. The key is deleted either way: they
' belong to exactly one exit.
function EfX_TakePrevCrumbs(sec as object) as object
    if not sec.Exists("prevCrumbs") then return []
    raw = sec.Read("prevCrumbs")
    sec.Delete("prevCrumbs")
    sec.Flush()
    crumbs = invalid
    if raw <> "" then crumbs = ParseJson(raw)
    if type(crumbs) <> "roArray" then return []
    return crumbs
end function

' Main() runs before this session writes anything, so the "screen" and
' "crumbs" it copies into "pendingExit" ("efScreen", "efCrumbs") are still the
' exited session's. They win over "prevScreen"/"prevCrumbs" (rotated by
' start(), after which the host may already have set a new screen).
function EfX_SnapCrumbs(info as object, fallback as object) as object
    raw = info["efCrumbs"]
    if raw = invalid or GetInterface(raw, "ifString") = invalid then return fallback
    crumbs = invalid
    if raw <> "" then crumbs = ParseJson(raw)
    if type(crumbs) <> "roArray" then return fallback
    return crumbs
end function

function EfX_SnapScreen(info as object, fallback as dynamic) as dynamic
    raw = info["efScreen"]
    if raw = invalid or GetInterface(raw, "ifString") = invalid then return fallback
    s = EfS_Normalize(raw)
    if s = invalid then return fallback
    return s
end function

function EfX_IsCrashCode(code as string) as boolean
    return code = "EXIT_BRIGHTSCRIPT_CRASH" or Instr(1, UCase(code), "CRASH") > 0
end function

function EfX_Process(sec as object, info as dynamic) as string
    prevCrumbs = EfX_TakePrevCrumbs(sec)
    prevScreen = EfS_TakePrev(sec)
    if type(info) <> "roAssociativeArray" then return "none"
    if info.exit_code = invalid or info.timestamp = invalid then return "none"
    if EfU_ReadOrInvalid(sec, "lastExitTs") = info.timestamp then return "none"
    sec.Write("lastExitTs", info.timestamp)
    result = "seen"
    if EfX_IsAbnormal(info.exit_code) then
        exitMs = EfU_MsFromIso(info.timestamp)
        lastCrash = EfU_ReadOrInvalid(sec, "lastCrashT")
        lastCrashMs = invalid
        if lastCrash <> invalid then lastCrashMs = ParseJson(lastCrash)
        ' No timestamp comparison: the OS exit time and the channel's roDateTime
        ' clock differ by tens of seconds on device. A Path A fatal crash always
        ' ends its session and "lastCrashT" is deleted at every exit check, so a
        ' present "lastCrashT" plus a crash-type exit is the same crash. Memory
        ' and system kills stay separate reports (they are not a BrightScript
        ' crash, so Path A's record does not describe them).
        if lastCrashMs <> invalid and EfX_IsCrashCode(info.exit_code) then
            ' Path A saw this crash: enrich its record (if still queued), never
            ' duplicate. Its own live crumbs, screen and memory reading are kept.
            EfQ_AttachExit(sec, lastCrashMs, EfX_Meta(info))
            result = "merged"
        else
            rec = EfX_ToRecord(info)
            rec.crumbs = EfX_SnapCrumbs(info, prevCrumbs)
            route = EfX_SnapScreen(info, prevScreen)
            if route <> invalid then rec.route = route
            ' The reporter's last reading from the session that exited; it is
            ' read here, before this session's reporter overwrites "mem".
            mem = EfU_ReadMem(sec, exitMs)
            if mem <> invalid then rec.memory = mem
            EfQ_Put(sec, rec)
            result = "reported"
        end if
    end if
    sec.Delete("lastCrashT")
    sec.Flush()
    return result
end function
