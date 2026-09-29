' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Owns all network I/O. On start: Path B exit check, then drain the queue.
' Afterwards it sleeps until `flush` is set, or until a retry backoff expires,
' waking every 5 s to poll memory pressure (roAppMemoryMonitor is not allowed
' on the render thread, so it lives here).

sub init()
    m.top.functionName = "EfRep_Run"
end sub

sub EfRep_Run()
    port = CreateObject("roMessagePort")
    m.top.observeField("flush", port)
    m.sec = CreateObject("roRegistrySection", "Everframe")
    m.state = { seen: {}, allowed: {} }
    backoff = 0
    m.ctx = invalid
    try
        m.ctx = EfE_Context(EF_VERSION())
    catch e
        print "[everframe] context unavailable: "; e.message
    end try
    try
        EfRep_CheckLastExit()
    catch e
        print "[everframe] startup check failed: "; e.message
    end try
    ' The exit check has snapshotted the last session's reading; drop it so a
    ' crash in this session never carries the previous session's value.
    m.sec.Delete("mem")
    m.sec.Flush()
    m.mem = invalid
    try
        m.mem = EfRep_MemInit(port)
    catch e
        print "[everframe] memory monitor unavailable: "; e.message
    end try
    EfRep_MemPoll()
    while true
        retry = false
        try
            ' A failed context build must not turn every record into "poison":
            ' rebuild it here, and EfD_Drain keeps records while it is invalid.
            if m.ctx = invalid then m.ctx = EfE_Context(EF_VERSION())
        catch e
            print "[everframe] context unavailable: "; e.message
        end try
        try
            retry = EfD_Drain(m.sec, m.ctx, m.state, EfRep_Post)
        catch e
            print "[everframe] drain failed: "; e.message
            retry = true
        end try
        if retry then
            if backoff = 0 then backoff = 5000 else backoff = backoff * 2
            if backoff > 300000 then backoff = 300000
            EfRep_Idle(port, backoff)
        else
            backoff = 0
            EfRep_Idle(port, 0)
        end if
    end while
end sub

' Returns when `flush` is set, or after ms milliseconds when ms > 0 (a retry
' backoff); ms = 0 waits for `flush` only. Meanwhile it wakes at least every
' 5 s to poll memory and handles OS memory warnings without draining.
sub EfRep_Idle(port as object, ms as integer)
    clock = CreateObject("roTimespan")
    while true
        timeout = 5000
        if ms > 0 then
            left = ms - clock.TotalMilliseconds()
            if left <= 0 then return
            if left < timeout then timeout = left
        end if
        msg = wait(timeout, port)
        EfRep_FlushCrumbs()
        if type(msg) = "roAppMemoryNotificationEvent" then
            EfRep_MemWarning(msg)
        else if msg <> invalid then
            return
        end if
        if m.mem <> invalid and m.mem.clock.TotalMilliseconds() >= 5000 then EfRep_MemPoll()
    end while
end sub

' roAppMemoryMonitor, feature-detected per method (absent before Roku OS 12.5
' or so; brs-node has it but reports 0 %). Invalid when unusable.
function EfRep_MemInit(port as object) as dynamic
    mon = CreateObject("roAppMemoryMonitor")
    if type(mon) <> "roAppMemoryMonitor" then return invalid
    if FindMemberFunction(mon, "GetMemoryLimitPercent") = invalid then return invalid
    mm = { mon: mon, state: EfMem_NewState(), limit: invalid, last: invalid, clock: CreateObject("roTimespan") }
    try
        if FindMemberFunction(mon, "GetChannelMemoryLimit") <> invalid then mm.limit = EfMem_LimitMb(mon.GetChannelMemoryLimit())
    catch e
        print "[everframe] memory limit unavailable: "; e.message
    end try
    try
        if FindMemberFunction(mon, "EnableMemoryWarningEvent") <> invalid and FindMemberFunction(mon, "SetMessagePort") <> invalid then
            mon.SetMessagePort(port)
            mon.EnableMemoryWarningEvent(true)
        end if
    catch e
        print "[everframe] memory warnings unavailable: "; e.message
    end try
    return mm
end function

sub EfRep_MemPoll()
    mm = m.mem
    if mm = invalid then return
    mm.clock.Mark()
    try
        pct = mm.mon.GetMemoryLimitPercent()
        if EfU_IsNum(pct) then
            crumb = EfMem_Check(mm.state, pct, mm.limit)
            if crumb <> invalid then EfRep_Crumb(crumb)
            now = EfU_NowMs()
            if EfMem_ShouldPersist(mm.last, pct, now) then
                mm.last = EfMem_Reading(pct, mm.limit, now)
                m.sec.Write("mem", FormatJson(mm.last))
                m.sec.Flush()
            end if
        end if
    catch e
        print "[everframe] memory poll failed: "; e.message
    end try
end sub

sub EfRep_MemWarning(msg as object)
    try
        pct = invalid
        if FindMemberFunction(msg, "GetInfo") <> invalid then
            info = msg.GetInfo()
            if type(info) = "roAssociativeArray" then pct = info.mem_limit_percent
        end if
        if not EfU_IsNum(pct) and m.mem <> invalid then pct = m.mem.mon.GetMemoryLimitPercent()
        limit = invalid
        if m.mem <> invalid then limit = m.mem.limit
        EfRep_Crumb(EfMem_WarningCrumb(pct, limit))
    catch e
        print "[everframe] memory warning failed: "; e.message
    end try
end sub

' Persists breadcrumbs the node throttled (its own Timer cannot fire: the
' node is not in the scene tree). Runs on every reporter wake (<= 5 s).
sub EfRep_FlushCrumbs()
    try
        g = m.global
        if type(g) <> "roSGNode" or not g.hasField("everframe") then return
        ef = g.everframe
        if type(ef) = "roSGNode" then ef.callFunc("flushCrumbs", invalid)
    catch err
        print "[everframe] crumb flush failed"
    end try
end sub

' Memory crumbs go through the Everframe node (render thread) so they share
' its ring buffer; "urgent" makes it persist them without the 2 s throttle.
sub EfRep_Crumb(crumb as object)
    crumb["urgent"] = true
    g = m.global
    if type(g) <> "roSGNode" or not g.hasField("everframe") then return
    ef = g.everframe
    if type(ef) = "roSGNode" then ef.callFunc("addBreadcrumb", crumb)
end sub

' The library cannot read GetLastExitInfo itself (Roku answers EXIT_UNKNOWN to
' ComponentLibrary code), so the channel's Main() stores it in "pendingExit".
sub EfRep_CheckLastExit()
    EfX_Process(m.sec, EfX_TakePending(m.sec))
end sub

function EfRep_Post(env as object) as integer
    cfg = m.top.config
    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetUrl(cfg.endpoint + "/api/ingest")
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    boundary = EfM_Boundary()
    xfer.AddHeader("Authorization", "Bearer " + cfg.sdkKey)
    xfer.AddHeader("Content-Type", "multipart/form-data; boundary=" + boundary)
    if not xfer.AsyncPostFromString(EfM_Body(FormatJson(env), boundary)) then return 0
    msg = wait(15000, port)
    if type(msg) = "roUrlEvent" then return msg.GetResponseCode()
    xfer.AsyncCancel()
    return 0
end function
