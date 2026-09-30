' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX

sub init()
    m.top.functionName = "crashInTask"
end sub

sub crashInTask()
    target = invalid
    target.crashFromTask()
end sub
