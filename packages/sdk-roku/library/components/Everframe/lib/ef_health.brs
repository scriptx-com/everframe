' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Anonymous launch observations. Compact registry records are independent of
' crash reports, fingerprints and rate limits. Only Main supplies exit evidence.
' tmp: is per application launch; a durable capability marker would go stale.
sub EfH_SetBridge(supported as boolean)
    DeleteFile("tmp:/everframe-health-launch.json")
    if supported then WriteAsciiFile("tmp:/everframe-health-launch.json", FormatJson({ id: CreateObject("roDeviceInfo").GetRandomUUID(), used: false }))
end sub

' Always called first in Main, even when disabled or GetLastExitInfo is absent.
' Delete durably before returning the previous pointer: no later launch may
' borrow it if this launch never loads/configures the library.
function EfH_TakeSession(sec as object) as dynamic
    EfH_SetBridge(false)
    previous = invalid
    if sec.Exists("hSession") then previous = ParseJson(sec.Read("hSession"))
    sec.Delete("hSession")
    if not sec.Flush() then return invalid
    return previous
end function

function EfH_Bytes(value as string) as integer
    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(value)
    return bytes.Count()
end function

function EfH_Keys(sec as object) as object
    keys = []
    for each k in sec.GetKeyList()
        if Left(k, 2) = "h_" then keys.Push(k)
    end for
    keys.Sort()
    return keys
end function

sub EfH_Purge(sec as object)
    sec.Write("hDisabled", "1")
    for each k in EfH_Keys(sec)
        sec.Delete(k)
    end for
    sec.Delete("hSession")
    sec.Delete("hLastExit")
    sec.Flush()
end sub

function EfH_List(sec as object) as object
    items = []
    for each k in EfH_Keys(sec)
        rec = ParseJson(sec.Read(k))
        if type(rec) = "roAssociativeArray" then
            items.Push({ key: k, rec: rec })
        else
            sec.Delete(k)
        end if
    end for
    return items
end function

' 2048 bytes for queue values + keys, <= 6 observations, and <= 768 bytes
' reserved separately for the active session. Drop oldest observations first.
function EfH_Put(sec as object, rec as object) as string
    json = FormatJson(rec)
    key = "h_" + Right("0000000000000" + rec.t.ToStr(), 13) + "_" + rec.q.ToStr() + "_" + Left(rec.r, 8)
    size = EfH_Bytes(json) + EfH_Bytes(key)
    if size > 768 then return ""
    keys = EfH_Keys(sec)
    total = size
    for each k in keys
        total = total + EfH_Bytes(sec.Read(k)) + EfH_Bytes(k)
    end for
    while keys.Count() > 0 and (total > 2048 or keys.Count() >= 6)
        k = keys.Shift()
        total = total - EfH_Bytes(sec.Read(k)) - EfH_Bytes(k)
        sec.Delete(k)
    end while
    if not sec.Write(key, json) or not sec.Flush() then
        sec.Delete(key)
        sec.Flush()
        return ""
    end if
    return key
end function

function EfH_Start(sec as object, cfg as object, app as object, now as dynamic) as boolean
    if cfg.releaseHealth = false or cfg.enabled = false then
        EfH_Purge(sec)
        return false
    end if
    sec.Delete("hDisabled")
    sec.Flush()
    if app.d <> false or EfU_IsDisabled(sec) then return false
    if not EfH_AppText(app.v) then return false
    if app.b <> invalid and not EfH_AppText(app.b) then return false
    ' Main's tmp: namespace need not be visible inside a ComponentLibrary.
    ' The host reads its launch token and passes that opaque string to start.
    if GetInterface(cfg.releaseHealthLaunch, "ifString") = invalid then return false
    bridge = ParseJson(cfg.releaseHealthLaunch)
    if type(bridge) <> "roAssociativeArray" or bridge.used <> false then return false
    if GetInterface(bridge.id, "ifString") = invalid then return false
    if not CreateObject("roRegex", "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "").IsMatch(bridge.id) then return false
    if EfU_ReadOrInvalid(sec, "hStartedLaunch") = bridge.id then return false
    if not sec.Write("hStartedLaunch", bridge.id) or not sec.Flush() then return false
    rec = { x: CreateObject("roDeviceInfo").GetRandomUUID(), p: bridge.id, r: CreateObject("roDeviceInfo").GetRandomUUID(), s: now, t: now, q: 0, v: app.v, b: app.b, z: EF_VERSION(), k: EfH_KeyHash(cfg.sdkKey), e: cfg.endpoint }
    if EfH_Bytes(FormatJson(rec)) + Len("hSession") > 768 then return false
    key = EfH_Put(sec, rec)
    if key = "" then return false
    ' Never arm a launch whose start did not survive a registry flush.
    if not sec.Write("hSession", FormatJson(rec)) or not sec.Flush() then
        sec.Delete("hSession")
        sec.Delete(key)
        sec.Flush()
        return false
    end if
    return true
end function

function EfH_KnownExit(code as dynamic) as boolean
    if GetInterface(code, "ifString") = invalid then return false
    known = {
        "EXIT_USER_NAV": true,
        "EXIT_UNKNOWN": true,
        "EXIT_POWER_MODE": true,
        "EXIT_DIAL_DELETE": true,
        "EXIT_OUT_OF_MEMORY": true,
        "EXIT_IDLE_AUTO_EXIT": true,
        "EXIT_BRIGHTSCRIPT_CRASH": true,
        "EXIT_NATIVE_CRASH": true,
        "EXIT_BRIGHTSCRIPT_STOP": true,
        "EXIT_BRIGHTSCRIPT_UNK_FUNC": true,
        "EXIT_BRIGHTSCRIPT_TIMEOUT": true,
        "EXIT_USER_KILL": true,
        "EXIT_AM_LOWRESOURCE": true,
        "EXIT_SYSTEM_KILL": true,
        "EXIT_GRAPHICS_NOT_RELEASED": true,
        "EXIT_DECODER_NOT_RELEASED": true,
        "EXIT_RUNNING_AFTER_SUSPEND": true,
        "EXIT_NOT_RESUMED": true,
        "EXIT_SIGNAL_TIMEOUT": true,
        "EXIT_APP_ERROR": true,
        "EXIT_UNLOADED": true,
        "EXIT_GUEST_MODE_ENABLED": true,
        "EXIT_GUEST_MODE_DISABLED": true,
        "EXIT_GUEST_CHECKOUT": true,
        "EXIT_OS_UPDATE": true,
        "EXIT_CHANNEL_UPDATE": true,
        "EXIT_CHANNEL_SIDELOAD": true,
        "EXIT_CHANNEL_RESTART": true,
        "EXIT_TILE_HIDDEN": true,
        "EXIT_SETTINGS_UPDATE": true,
        "EXIT_CHANNEL_MEM_LIMIT_FG": true,
        "EXIT_CHANNEL_MEM_LIMIT_BG": true,
        "EXIT_ADDON_DEPENDENCY": true,
        "EXIT_SOFTFAIL": true
    }
    return known.DoesExist(code)
end function

sub EfH_Exit(sec as object, previous as dynamic, info as dynamic)
    if EfU_IsDisabled(sec) or sec.Exists("hDisabled") then return
    if type(info) <> "roAssociativeArray" then return
    if not EfH_KnownExit(info.exit_code) or GetInterface(info.timestamp, "ifString") = invalid then return
    if not CreateObject("roRegex", "^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$", "").IsMatch(info.timestamp) then return
    if EfU_ReadOrInvalid(sec, "hLastExit") = info.timestamp then return
    ' Remember evidence even without an eligible session: the API may replay it.
    if not sec.Write("hLastExit", info.timestamp) or not sec.Flush() then return
    if type(previous) <> "roAssociativeArray" then return
    if previous.q <> 0 or not EfU_IsNum(previous.s) then return
    previous.r = CreateObject("roDeviceInfo").GetRandomUUID()
    previous.t = EfU_MsFromIso(info.timestamp)
    ' Roku's exit clock can lag the channel clock. Ownership is by the frozen
    ' pointer, never by timestamp; clamp duration for the wire invariant only.
    if previous.t < previous.s then previous.t = previous.s
    previous.q = 2
    if info.exit_code = "EXIT_USER_NAV" then previous.q = 1
    previous.c = info.exit_code
    EfH_Put(sec, previous)
end sub

function EfH_Envelope(rec as object) as object
    exposure = {
        "exposureId": rec.x, "processLaunchId": rec.p, "startedAt": EfU_IsoFromMs(rec.s),
        platform: "roku", "sdkVersion": rec.z,
        app: { version: rec.v, build: rec.b, debug: false },
        "loadedBuildId": invalid, "loadedBundleStatus": "not_applicable",
        subject: { kind: "anonymous" }, "sessionPolicy": "launch-v1",
        coverage: { policy: "roku-exit-info-v1", "sampleRate": 1, "priorQueueLosses": invalid, "queueLossAccounting": "unavailable" }
    }
    env = { "schemaVersion": 7, "recordId": rec.r, exposure: exposure, "capturedAt": EfU_IsoFromMs(rec.t), sequence: rec.q, "elapsedMs": rec.t - rec.s }
    if rec.q = 0 then
        env.phase = "start"
    else if rec.q = 1 then
        env.phase = "end"
        env.outcome = "completed"
        env["endReason"] = "user_navigation"
    else
        env.phase = "exit"
        env.outcome = "terminated"
        env["exitCode"] = rec.c
    end if
    return env
end function

' Persist a fingerprint, never a credential. Retries use the current key only.
function EfH_KeyHash(key as string) as string
    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(key)
    digest = CreateObject("roEVPDigest")
    digest.Setup("sha256")
    return LCase(digest.Process(bytes))
end function

function EfH_Drain(sec as object, cfg as object, now as dynamic, post as function) as boolean
    if cfg.releaseHealth = false or cfg.enabled = false or EfU_IsDisabled(sec) then
        EfH_Purge(sec)
        return false
    end if
    if cfg.debugBuild <> false then return false
    binding = EfH_KeyHash(cfg.sdkKey)
    retry = false
    for each item in EfH_List(sec)
        if EfU_IsDisabled(sec) or sec.Exists("hDisabled") then return false
        rec = item.rec
        drop = rec.k <> binding or rec.e <> cfg.endpoint
        if not EfU_IsNum(rec.t) then
            drop = true
        else if now - rec.t > 604800000& then
            drop = true
        end if
        if not drop then
            env = invalid
            try
                env = EfH_Envelope(rec)
            catch ignored
            end try
            if env = invalid then
                drop = true
            else
                status = post(env)
                drop = (status >= 200 and status < 300) or (status >= 400 and status < 500 and status <> 408 and status <> 429)
                if not drop then retry = true
                if status = 0 then return true
            end if
        end if
        if drop then
            sec.Delete(item.key)
            sec.Flush()
        end if
    end for
    return retry
end function

' Count UTF-16 units like the wire schema, while rejecting controls and UTF-8
' encodings of lone surrogates. Never truncate a release identity to make it fit.
function EfH_AppText(value as dynamic) as boolean
    if GetInterface(value, "ifString") = invalid then return false
    if value.Trim() = "" then return false
    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(value)
    units = 0
    for i = 0 to bytes.Count() - 1
        b = bytes[i]
        if b < 32 then return false
        if b < 128 or b >= 192 then units = units + 1
        if b >= 240 then units = units + 1
        if b = 237 and i + 1 < bytes.Count() then
            if bytes[i + 1] >= 160 then return false
        end if
    end for
    return units > 0 and units <= 64
end function
