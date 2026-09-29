' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Never instrumented. The Timer fires this callback from the event loop, so no
' wrapped function is on the stack: the crash is invisible to Path A and only
' the next-launch GetLastExitInfo path (Roku OS 13+) can report it.

sub onCrashExcluded()
    unwrapped = invalid
    unwrapped.crashInExcludedFile()
end sub
