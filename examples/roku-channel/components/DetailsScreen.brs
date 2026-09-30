' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' No manual screen call here on purpose: `everframe-roku instrument` adds the
' screen hook to this init() because the component name matches *Screen.

sub init()
    m.label = m.top.findNode("label")
end sub
