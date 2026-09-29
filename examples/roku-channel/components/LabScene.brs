' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX

function LabScenarios() as object
    return [
        { id: "crash_select", title: "1  Crash: list selection (render thread)" },
        { id: "crash_key", title: "2  Crash: press ✱ (onKeyEvent)" },
        { id: "crash_task", title: "3  Crash: inside a Task" },
        { id: "crash_main", title: "4  Crash: before the scene (next launch)" },
        { id: "handled", title: "5  Report handled error" },
        { id: "crash_excluded", title: "6  Crash: excluded file (next launch only)" },
        { id: "oom", title: "7  Out of memory (in a Task)" },
        { id: "crash_loop", title: "8  Crash loop ×4 (relaunch 4 times)" },
        { id: "user_crumbs", title: "9  Set user + add breadcrumbs" }
    ]
end function

sub init()
    m.cfg = EfExample_Config()
    m.started = false
    m.note = ""
    m.lab = CreateObject("roRegistrySection", "EverframeLab")

    content = CreateObject("roSGNode", "ContentNode")
    for each s in LabScenarios()
        item = content.CreateChild("ContentNode")
        item.title = s.title
    end for
    m.list = m.top.findNode("list")
    m.list.content = content
    m.list.observeField("itemSelected", "onItemSelected")
    m.list.setFocus(true)

    m.status = m.top.findNode("status")
    m.lib = m.top.createChild("ComponentLibrary")
    m.lib.id = "Everframe"
    m.lib.observeField("loadStatus", "onLibraryStatus")
    m.lib.uri = m.cfg.libraryUri

    m.excludedTimer = m.top.createChild("Timer")
    m.excludedTimer.duration = 0.1
    m.excludedTimer.observeField("fire", "onCrashExcluded")

    m.loopTimer = m.top.createChild("Timer")
    m.loopTimer.duration = 1
    m.loopTimer.observeField("fire", "onLoopCrash")

    updateStatus()
end sub

sub onLibraryStatus()
    if m.lib.loadStatus = "ready" and not m.started then
        ef = CreateObject("roSGNode", "Everframe:Everframe")
        cfg = { sdkKey: m.cfg.sdkKey }
        if m.cfg.endpoint <> "" then cfg.endpoint = m.cfg.endpoint
        m.started = ef.callFunc("start", cfg)
        ' Scenario 8: keep crashing on launch until the counter runs out.
        left = m.lab.Read("loopLeft")
        if left <> "" and Val(left) > 0 then
            m.lab.Write("loopLeft", (Val(left) - 1).ToStr())
            m.lab.Flush()
            m.note = "crash loop: " + (Val(left) - 1).ToStr() + " left after this one"
            m.loopTimer.control = "start"
        end if
    end if
    updateStatus()
end sub

sub onItemSelected()
    id = LabScenarios()[m.list.itemSelected].id
    if id = "crash_select" then
        LabCrashNow("list selection")
    else if id = "crash_key" then
        m.note = "press ✱ (options) now"
    else if id = "crash_task" then
        m.crashTask = CreateObject("roSGNode", "CrashTask")
        m.crashTask.control = "RUN"
    else if id = "crash_main" then
        m.lab.Write("crashInMain", "1")
        m.lab.Flush()
        m.note = "armed: press Home, relaunch the channel (it crashes), relaunch again to send"
    else if id = "handled" then
        LabReportHandled()
    else if id = "crash_excluded" then
        m.excludedTimer.control = "start"
    else if id = "oom" then
        m.oomTask = CreateObject("roSGNode", "OomTask")
        m.oomTask.control = "RUN"
        m.note = "allocating… the OS should kill the channel; relaunch to send"
    else if id = "crash_loop" then
        m.lab.Write("loopLeft", "4")
        m.lab.Flush()
        LabCrashNow("crash loop start")
    else if id = "user_crumbs" then
        LabSetUserAndCrumbs()
    end if
    updateStatus()
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if press and key = "options" then
        LabCrashNow("options key")
    end if
    return false
end function

sub onLoopCrash()
    LabCrashNow("crash loop")
end sub

sub LabCrashNow(where as string)
    target = invalid
    target.crashFrom(where)
end sub

sub LabReportHandled()
    ef = m.global.everframe
    if ef = invalid then
        m.note = "SDK not started yet"
        return
    end if
    try
        throw "Crash lab handled error"
    catch e
        ok = ef.callFunc("captureException", e)
        m.note = "handled error reported: " + ok.ToStr()
    end try
end sub

sub LabSetUserAndCrumbs()
    ef = m.global.everframe
    if ef = invalid then
        m.note = "SDK not started yet"
        return
    end if
    ef.callFunc("setUser", { id: 42, email: "lab@example.com", displayName: "Crash Lab" })
    ef.callFunc("addBreadcrumb", { kind: "custom", message: "crash lab breadcrumb", level: "info" })
    m.note = "user 42 set + breadcrumb added (attached to the next report)"
end sub

sub updateStatus()
    lines = []
    lines.Push("Library: " + m.lib.loadStatus + " (" + m.cfg.libraryUri + ")")
    lines.Push("SDK started: " + m.started.ToStr())
    lines.Push("Queued records: " + LabQueueCount().ToStr())
    lines.Push("Last exit: " + LabLastExit())
    if m.note <> "" then lines.Push("")
    if m.note <> "" then lines.Push(m.note)
    m.status.text = lines.Join(Chr(10))
end sub

function LabQueueCount() as integer
    sec = CreateObject("roRegistrySection", "Everframe")
    n = 0
    for each k in sec.GetKeyList()
        if Left(k, 1) = "r" and Instr(1, "0123456789", Mid(k, 2, 1)) > 0 then n = n + 1
    end for
    return n
end function

function LabLastExit() as string
    am = CreateObject("roAppManager")
    if FindMemberFunction(am, "GetLastExitInfo") = invalid then return "n/a (Roku OS < 13)"
    info = am.GetLastExitInfo()
    if type(info) <> "roAssociativeArray" then return "none"
    code = info.exit_code
    if code = invalid then return "none"
    text = code.ToStr()
    ts = info.timestamp
    if ts <> invalid then text = text + " at " + ts.ToStr()
    return text
end function
