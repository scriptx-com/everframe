' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Runs on a Task thread so the render thread stays responsive: the OS memory
' limit kills the channel (EXIT_CHANNEL_MEM_LIMIT_FG / EXIT_OUT_OF_MEMORY)
' rather than the render-thread watchdog.

sub init()
    m.top.functionName = "exhaustMemory"
end sub

sub exhaustMemory()
    hog = []
    while true
        chunk = CreateObject("roByteArray")
        chunk.SetResize(4 * 1024 * 1024, false)
        chunk[4 * 1024 * 1024 - 1] = 1
        hog.Push(chunk)
        ' Climb gradually (~16 MB/s) so the SDK's 5 s memory poll sees 75/90/95 %.
        sleep(250)
    end while
end sub
