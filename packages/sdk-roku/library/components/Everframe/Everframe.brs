' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Host-facing node. Runs on the render thread; all network I/O is in
' EverframeReporter. Every function swallows its own errors: the SDK must
' never throw into the host.

sub init()
    m.crumbs = []
    m.seq = 0
    m["maxCrumbs"] = 50
    m.user = invalid
    m.reporter = invalid
    ' Crash-surviving crumbs (ef_crumbs.brs): off until start() has rotated
    ' the previous session's "crumbs" to "prevCrumbs".
    m.sec = invalid
    m["lastPersistMs"] = invalid
    m["persistPending"] = false
    m["persistTimer"] = invalid
end sub

function start(config as object) as boolean
    try
        if m.reporter <> invalid then return true
        if type(config) <> "roAssociativeArray" or config.sdkKey = invalid or config.sdkKey = "" then
            print "[everframe] start() needs { sdkKey }"
            return false
        end if
        if config.enabled = false then return false
        if config.maxBreadcrumbs <> invalid then m["maxCrumbs"] = EfU_MaxCrumbs(config.maxBreadcrumbs)
        ' Rotate before anything of this session is persisted: the reporter
        ' attaches "prevCrumbs" to the previous session's exit-info record.
        sec = CreateObject("roRegistrySection", "Everframe")
        EfC_Rotate(sec)
        m.sec = sec
        EfN_SetupPersistTimer()
        if m.crumbs.Count() > 0 then
            EfC_Persist(sec, m.crumbs)
            m["lastPersistMs"] = EfU_NowMs()
        end if
        endpoint = "https://everframe.dev"
        if config.endpoint <> invalid and config.endpoint <> "" then endpoint = config.endpoint
        m.reporter = CreateObject("roSGNode", "EverframeReporter")
        m.reporter.config = { "sdkKey": config.sdkKey, endpoint: endpoint }
        m.reporter.control = "RUN"
        if m.global.hasField("everframe") then
            m.global.everframe = m.top
        else
            m.global.addFields({ everframe: m.top })
        end if
        return true
    catch e
        print "[everframe] start failed: "; e.message
        return false
    end try
end function

function captureException(e as dynamic) as boolean
    try
        rec = EfR_FromException(e, "captureException", true)
        rec.crumbs = getCrumbs(invalid)
        if m.user <> invalid then rec.user = m.user
        sec = CreateObject("roRegistrySection", "Everframe")
        mem = EfU_ReadMem(sec, rec.t)
        if mem <> invalid then rec.memory = mem
        EfQ_Put(sec, rec)
        kick(invalid)
        return true
    catch err
        return false
    end try
end function

function addBreadcrumb(c as dynamic) as boolean
    try
        if type(c) <> "roAssociativeArray" then return false
        kinds = { navigation: true, tap: true, console: true, network: true, lifecycle: true, error: true, custom: true }
        kind = "custom"
        if c.kind <> invalid and kinds.DoesExist(c.kind) then kind = LCase(c.kind)
        crumb = { t: EfU_NowMs(), seq: m.seq, kind: kind, message: EfU_Truncate(c.message, 2048) }
        level = EfU_NormalizeLevel(c.level)
        if level <> invalid then crumb.level = level
        if type(c.data) = "roAssociativeArray" then crumb.data = c.data
        m.seq = m.seq + 1
        m.crumbs.Push(crumb)
        while m.crumbs.Count() > m.maxCrumbs
            m.crumbs.Shift()
        end while
        ' "urgent" (memory crumbs from the reporter) skips the 2 s throttle:
        ' an out-of-memory kill may follow within moments.
        urgent = false
        if type(c.urgent) = "roBoolean" or type(c.urgent) = "Boolean" then urgent = c.urgent
        EfN_PersistCrumbs(urgent)
        return true
    catch err
        return false
    end try
end function

function setUser(u as dynamic) as boolean
    try
        ' id / email / displayName become strings; invalid or non-scalar values
        ' are dropped (ingest rejects non-string user fields).
        m.user = EfU_NormalizeUser(u)
        return true
    catch err
        return false
    end try
end function

function getCrumbs(unused as dynamic) as object
    try
        out = []
        out.Append(m.crumbs)
        return out
    catch err
        return []
    end try
end function

function getUser(unused as dynamic) as dynamic
    return m.user
end function

function kick(unused as dynamic) as boolean
    try
        if m.reporter <> invalid then m.reporter.flush = true
        return true
    catch err
        return false
    end try
end function

sub EfN_SetupPersistTimer()
    t = CreateObject("roSGNode", "Timer")
    t.duration = 2
    t.repeat = false
    t.observeField("fire", "EfN_OnPersistTimer")
    m.top.appendChild(t)
    m["persistTimer"] = t
end sub

' Writes now when the throttle allows, else marks a write pending and lets
' the one-shot timer flush it (at most one registry write per 2 s).
sub EfN_PersistCrumbs(urgent as boolean)
    if m.sec = invalid then return
    now = EfU_NowMs()
    if EfC_ShouldWrite(m.lastPersistMs, now, urgent) then
        EfC_Persist(m.sec, m.crumbs)
        m["lastPersistMs"] = now
        m["persistPending"] = false
    else if m.persistPending <> true and m.persistTimer <> invalid then
        m["persistPending"] = true
        m.persistTimer.control = "start"
    end if
end sub

sub EfN_OnPersistTimer()
    try
        if m.sec = invalid or m.crumbs = invalid or m.persistPending <> true then return
        EfC_Persist(m.sec, m.crumbs)
        m["lastPersistMs"] = EfU_NowMs()
        m["persistPending"] = false
    catch err
        print "[everframe] could not persist breadcrumbs"
    end try
end sub
