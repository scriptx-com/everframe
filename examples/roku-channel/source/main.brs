' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Scenario 4 ("crash before the scene") sets the crashInMain flag; the next
' launch crashes here, before any Everframe node exists, so the hook must
' persist the record straight to the registry.

sub Main()
    lab = CreateObject("roRegistrySection", "EverframeLab")
    if lab.Exists("crashInMain") then
        lab.Delete("crashInMain")
        lab.Flush()
        LabCrashBeforeScene()
    end if
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    screen.CreateScene("LabScene")
    screen.Show()
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" and msg.IsScreenClosed() then return
    end while
end sub

sub LabCrashBeforeScene()
    nothing = invalid
    nothing.crashBeforeScene()
end sub
