' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Memory-pressure logic for the reporter Task, free of SceneGraph so it can be
' unit-tested. The reporter polls roAppMemoryMonitor.GetMemoryLimitPercent()
' and feeds each reading to EfMem_Check, which returns a breadcrumb the first
' time usage crosses 75, 90 or 95 % (a threshold re-arms once usage drops at
' least 5 points below it), else invalid.

function EfMem_NewState() as object
    return { fired: {} }
end function

function EfMem_Thresholds() as object
    return [75, 90, 95]
end function

function EfMem_Check(state as object, percent as dynamic, limitMb as dynamic) as dynamic
    if not EfU_IsNum(percent) then return invalid
    crossed = false
    for each t in EfMem_Thresholds()
        key = t.ToStr()
        if percent >= t then
            if state.fired[key] <> true then
                state.fired[key] = true
                crossed = true
            end if
        else if percent <= t - 5 then
            state.fired[key] = false
        end if
    end for
    if not crossed then return invalid
    return EfMem_Crumb(EfMem_Label(percent, limitMb), percent, limitMb)
end function

function EfMem_WarningCrumb(percent as dynamic, limitMb as dynamic) as object
    msg = "memory warning from OS"
    if EfU_IsNum(percent) then msg = msg + " (" + EfMem_Int(percent) + "%)"
    return EfMem_Crumb(msg, percent, limitMb)
end function

function EfMem_Label(percent as dynamic, limitMb as dynamic) as string
    s = "memory " + EfMem_Int(percent) + "%"
    if EfU_IsNum(limitMb) then s = s + " of " + EfMem_Int(limitMb) + " MB"
    return s
end function

function EfMem_Int(n as dynamic) as string
    return Int(n).ToStr()
end function

function EfMem_Crumb(message as string, percent as dynamic, limitMb as dynamic) as object
    data = {}
    if EfU_IsNum(percent) then data["percent"] = percent
    if EfU_IsNum(limitMb) then data["limitMb"] = limitMb
    return { kind: "custom", level: "warn", message: message, data: data }
end function

' roAppMemoryMonitor.GetChannelMemoryLimit() -> foreground limit in MB, or
' invalid when unknown (0 or missing). Values too large to be MB are KB.
function EfMem_LimitMb(limits as dynamic) as dynamic
    if type(limits) <> "roAssociativeArray" then return invalid
    v = limits.maxForegroundMemory
    if not EfU_IsNum(v) or v <= 0 then return invalid
    if v > 16384 then v = v / 1024
    return Int(v)
end function

function EfMem_Reading(percent as dynamic, limitMb as dynamic, nowMs as dynamic) as object
    r = { "percent": percent }
    if EfU_IsNum(limitMb) then r["limitMb"] = limitMb
    r["t"] = nowMs
    return r
end function

' Persist "mem" when the percentage moved by >= 1 point or 30 s passed.
function EfMem_ShouldPersist(last as dynamic, percent as dynamic, nowMs as dynamic) as boolean
    if type(last) <> "roAssociativeArray" then return true
    if not EfU_IsNum(last.percent) or not EfU_IsNum(last.t) then return true
    if Abs(percent - last.percent) >= 1 then return true
    return nowMs - last.t >= 30000
end function
