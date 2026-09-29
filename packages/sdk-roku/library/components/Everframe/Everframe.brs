' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Host-facing node. Runs on the render thread; all network I/O is in
' EverframeReporter. Every function swallows its own errors: the SDK must
' never throw into the host.

sub init()
    m.crumbs = []
    m.seq = 0
    m.maxCrumbs = 50
    m.user = invalid
    m.reporter = invalid
end sub

function start(config as object) as boolean
    try
        if m.reporter <> invalid then return true
        if type(config) <> "roAssociativeArray" or config.sdkKey = invalid or config.sdkKey = "" then
            print "[everframe] start() needs { sdkKey }"
            return false
        end if
        if config.enabled = false then return false
        if config.maxBreadcrumbs <> invalid then m.maxCrumbs = EfU_MaxCrumbs(config.maxBreadcrumbs)
        endpoint = "https://everframe.dev"
        if config.endpoint <> invalid and config.endpoint <> "" then endpoint = config.endpoint
        m.reporter = CreateObject("roSGNode", "EverframeReporter")
        m.reporter.config = { sdkKey: config.sdkKey, endpoint: endpoint }
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
        EfQ_Put(CreateObject("roRegistrySection", "Everframe"), rec)
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
