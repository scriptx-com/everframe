' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Registry-backed record queue. One key per record so the hook (any thread)
' and the reporter never read-modify-write a shared blob. Keys are
' "r" + 13-digit ms + "_" + 8 id chars, so sorting keys sorts by time.
' Roku gives a channel ~16KB of registry: 6 records x 2000 chars.

function EfQ_MaxRecords() as integer
    return 6
end function

function EfQ_MaxChars() as integer
    return 2000
end function

function EfQ_Keys(sec as object) as object
    keys = []
    for each k in sec.GetKeyList()
        if Left(k, 1) = "r" and Instr(1, "0123456789", Mid(k, 2, 1)) > 0 then keys.Push(k)
    end for
    keys.Sort()
    return keys
end function

function EfQ_Fit(rec as object) as string
    json = FormatJson(rec)
    while Len(json) > EfQ_MaxChars() and rec.crumbs <> invalid and rec.crumbs.Count() > 0
        rec.crumbs.Shift()
        json = FormatJson(rec)
    end while
    if Len(json) > EfQ_MaxChars() and rec.frames <> invalid and rec.frames.Count() > 10 then
        kept = []
        for i = 0 to 9
            kept.Push(rec.frames[i])
        end for
        rec.frames = kept
        json = FormatJson(rec)
    end if
    if Len(json) > EfQ_MaxChars() then
        rec.message = EfU_Truncate(rec.message, 256)
        for each f in rec.frames
            f.raw = EfU_Truncate(f.raw, 96)
        end for
        if rec.exitInfo <> invalid and rec.exitInfo.consoleLog <> invalid then
            rec.exitInfo["consoleLog"] = EfU_Tail(rec.exitInfo.consoleLog, 256)
        end if
        json = FormatJson(rec)
    end if
    return json
end function

function EfQ_Put(sec as object, rec as object) as string
    if rec.id = invalid then rec.id = CreateObject("roDeviceInfo").GetRandomUUID()
    json = EfQ_Fit(rec)
    keys = EfQ_Keys(sec)
    while keys.Count() >= EfQ_MaxRecords()
        sec.Delete(keys.Shift())
    end while
    key = "r" + Right("0000000000000" + rec.t.ToStr(), 13) + "_" + Left(rec.id, 8)
    sec.Write(key, json)
    if rec.fatal = true and rec.kind = "crash" then sec.Write("lastCrashT", rec.t.ToStr())
    sec.Flush()
    return key
end function

function EfQ_List(sec as object) as object
    out = []
    for each k in EfQ_Keys(sec)
        rec = ParseJson(sec.Read(k))
        if type(rec) = "roAssociativeArray" then
            out.Push({ key: k, rec: rec })
        else
            sec.Delete(k)
        end if
    end for
    sec.Flush()
    return out
end function

sub EfQ_Remove(sec as object, key as string)
    sec.Delete(key)
    sec.Flush()
end sub

function EfQ_AttachExit(sec as object, t as dynamic, exitInfo as object) as boolean
    prefix = "r" + Right("0000000000000" + t.ToStr(), 13) + "_"
    for each k in EfQ_Keys(sec)
        if Left(k, Len(prefix)) = prefix then
            rec = ParseJson(sec.Read(k))
            if type(rec) = "roAssociativeArray" then
                rec["exitInfo"] = exitInfo
                sec.Write(k, EfQ_Fit(rec))
                sec.Flush()
                return true
            end if
        end if
    end for
    return false
end function

' Crash-loop guard: once per launch (`seen`, owned by the caller) and at most
' 3 sends per fingerprint per rolling hour (persisted under "rl").
function EfQ_Allow(sec as object, fp as string, nowMs as dynamic, seen as object) as boolean
    if seen.DoesExist(fp) then return false
    raw = EfU_ReadOrInvalid(sec, "rl")
    rl = invalid
    if raw <> invalid then rl = ParseJson(raw)
    if type(rl) <> "roAssociativeArray" then rl = {}
    recent = []
    if type(rl[fp]) = "roArray" then
        for each t in rl[fp]
            if nowMs - t < 3600000& then recent.Push(t)
        end for
    end if
    if recent.Count() >= 3 then return false
    recent.Push(nowMs)
    ' Rewrite rl with only in-window timestamps; fingerprints left empty are dropped.
    pruned = {}
    for each k in rl
        if type(rl[k]) = "roArray" then
            keep = []
            for each t in rl[k]
                if nowMs - t < 3600000& then keep.Push(t)
            end for
            if keep.Count() > 0 then pruned[k] = keep
        end if
    end for
    pruned[fp] = recent
    rl = pruned
    sec.Write("rl", FormatJson(rl))
    sec.Flush()
    seen[fp] = true
    return true
end function
