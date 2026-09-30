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
    m["crumbsDirty"] = false
    ' Current screen (ef_screen.brs), sent as context.route.
    m.screen = invalid
    ' Set by start({ enabled: false }): nothing is collected until an enabled start().
    m.disabled = false
end sub

function start(config as object) as boolean
    try
        if m.reporter <> invalid then
            ' start({ enabled: false }) after a successful start turns it off
            ' (e.g. the viewer withdrew consent).
            if type(config) = "roAssociativeArray" and config.enabled = false then
                EfN_Disable(EfU_Section())
                return false
            end if
            return true
        end if
        if type(config) <> "roAssociativeArray" or config.sdkKey = invalid or config.sdkKey = "" then
            print "[everframe] start() needs { sdkKey }"
            return false
        end if
        sec = EfU_Section()
        if config.enabled = false then
            EfN_Disable(sec)
            return false
        end if
        m.disabled = false
        if sec.Exists("disabled") then
            sec.Delete("disabled")
            sec.Flush()
        end if
        if config.maxBreadcrumbs <> invalid then m["maxCrumbs"] = EfU_MaxCrumbs(config.maxBreadcrumbs)
        ' Rotate before anything of this session is persisted: the reporter
        ' attaches "prevCrumbs" to the previous session's exit-info record.
        EfC_Rotate(sec)
        EfS_Rotate(sec)
        EfU_RotateVersion(sec)
        m.sec = sec
        if m.crumbs.Count() > 0 then
            EfC_Persist(sec, m.crumbs)
            m["lastPersistMs"] = EfU_NowMs()
            m["crumbsDirty"] = false
        end if
        if m.screen <> invalid then EfS_Persist(sec, m.screen)
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
        sec = EfU_Section()
        if EfU_IsDisabled(sec) then return false
        rec = EfR_FromException(e, "captureException", true)
        rec.crumbs = getCrumbs(invalid)
        if m.user <> invalid then rec.user = m.user
        if m.screen <> invalid then rec.route = m.screen
        mem = EfU_ReadMem(sec, rec.t)
        if mem <> invalid then rec.memory = mem
        if EfQ_Put(sec, rec) = "" then return false
        kick(invalid)
        return true
    catch err
        return false
    end try
end function

function addBreadcrumb(c as dynamic) as boolean
    try
        if m.disabled or type(c) <> "roAssociativeArray" then return false
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
        if m.disabled then return false
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

' Sets the current screen (context.route on every report) and leaves a
' navigation breadcrumb. Returns true when the screen changed; blank, invalid
' or non-scalar names and repeats of the current screen are ignored.
function setScreen(name as dynamic) as boolean
    try
        if m.disabled then return false
        s = EfS_Normalize(name)
        if s = invalid then return false
        if m.screen <> invalid and m.screen = s then return false
        prev = m.screen
        m.screen = s
        addBreadcrumb(EfS_Crumb(prev, s))
        ' Tiny, so written at once: a crash right after navigating still
        ' reports the new screen on the next launch.
        if m.sec <> invalid then EfS_Persist(m.sec, s)
        return true
    catch err
        return false
    end try
end function

function getScreen(unused as dynamic) as dynamic
    return m.screen
end function

function kick(unused as dynamic) as boolean
    try
        if m.reporter <> invalid then m.reporter.flush = true
        return true
    catch err
        return false
    end try
end function

' Writes now when >= 2 s passed since the last write (or when urgent), else
' marks the buffer dirty; the reporter loop calls flushCrumbs() to write it.
' This node is not in the scene tree, so a Timer child would never fire.
sub EfN_PersistCrumbs(urgent as boolean)
    if m.sec = invalid then return
    now = EfU_NowMs()
    if urgent or EfC_ShouldPersist(now, m["lastPersistMs"]) then
        EfC_Persist(m.sec, m.crumbs)
        m["lastPersistMs"] = now
        m["crumbsDirty"] = false
    else
        m["crumbsDirty"] = true
    end if
end sub

' Writes the persisted buffer if a throttled addBreadcrumb left it dirty.
function flushCrumbs(unused as dynamic) as boolean
    try
        if m.sec = invalid or m.crumbs = invalid or m["crumbsDirty"] <> true then return false
        EfC_Persist(m.sec, m.crumbs)
        m["lastPersistMs"] = EfU_NowMs()
        m["crumbsDirty"] = false
        return true
    catch err
        print "[everframe] could not persist breadcrumbs"
        return false
    end try
end function

' Remembered in the registry so the injected hook stops recording too, and
' nothing captured so far is uploaded by a later enabled start(). A running
' reporter is stopped and this session's crumbs and user are dropped.
sub EfN_Disable(sec as object)
    sec.Write("disabled", "1")
    for each k in EfQ_Keys(sec)
        sec.Delete(k)
    end for
    for each k in ["pendingExit", "lastCrashT", "crumbs", "prevCrumbs", "screen", "prevScreen"]
        sec.Delete(k)
    end for
    sec.Flush()
    if m.reporter <> invalid then
        ' The reporter sees "disabled" when it wakes and returns.
        m.reporter.flush = true
        m.reporter.control = "STOP"
        m.reporter = invalid
    end if
    m.sec = invalid
    m.crumbs = []
    m.user = invalid
    m.screen = invalid
    m.disabled = true
end sub
