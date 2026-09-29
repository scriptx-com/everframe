' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Breadcrumbs that survive a crash. The Everframe node keeps its in-memory
' ring buffer and also persists the latest crumbs to registry "Everframe"/
' "crumbs". start() rotates them to "prevCrumbs" before the new session writes
' anything, and the reporter attaches "prevCrumbs" to the next-launch exit-info
' record (EfX_Process), then deletes it.
'
' Registry budget (Roku gives a channel ~16 KB in total):
'   queue       6 records x 2000 chars = 12000  (ef_queue.brs)
'   crumbs      <= 2000                        (this file)
'   prevCrumbs  <= 2000, transient: exists only between start() and the
'               reporter's startup exit check, while "crumbs" is still small
'   screen, prevScreen: <= 128 each (ef_screen.brs)
'   mem, rl, lastExitTs, lastCrashT: small; pendingExit: transient

function EfC_MaxPersist() as integer
    return 20
end function

function EfC_MaxChars() as integer
    return 2000
end function

' Latest 20 crumbs as JSON, dropping the oldest until it fits 2000 chars. A
' single crumb that still does not fit keeps a truncated message and no data.
function EfC_Serialize(crumbs as dynamic) as string
    if type(crumbs) <> "roArray" or crumbs.Count() = 0 then return "[]"
    keep = []
    first = crumbs.Count() - EfC_MaxPersist()
    if first < 0 then first = 0
    for i = first to crumbs.Count() - 1
        keep.Push(crumbs[i])
    end for
    json = FormatJson(keep)
    while Len(json) > EfC_MaxChars() and keep.Count() > 1
        keep.Shift()
        json = FormatJson(keep)
    end while
    if Len(json) > EfC_MaxChars() then
        c = keep[0]
        small = { t: c.t, seq: c.seq, kind: c.kind, message: EfU_Truncate(c.message, 512) }
        if c.level <> invalid then small.level = c.level
        json = FormatJson([small])
        if Len(json) > EfC_MaxChars() then json = "[]"
    end if
    return json
end function

sub EfC_Persist(sec as object, crumbs as dynamic)
    sec.Write("crumbs", EfC_Serialize(crumbs))
    sec.Flush()
end sub

' Moves the last session's "crumbs" to "prevCrumbs" (overwriting) and clears
' "crumbs". With no "crumbs", a "prevCrumbs" left by an older session is
' dropped so it can never be attached to a later, unrelated exit.
sub EfC_Rotate(sec as object)
    if sec.Exists("crumbs") then
        sec.Write("prevCrumbs", sec.Read("crumbs"))
        sec.Delete("crumbs")
    else if sec.Exists("prevCrumbs") then
        sec.Delete("prevCrumbs")
    end if
    sec.Flush()
end sub

' Throttle: persist when nothing was written yet or >= 2 s have passed since
' the last write. (Urgent memory crumbs bypass this in the node.)
function EfC_ShouldPersist(nowMs as dynamic, lastMs as dynamic) as boolean
    if lastMs = invalid or nowMs = invalid then return true
    return nowMs - lastMs >= 2000
end function
