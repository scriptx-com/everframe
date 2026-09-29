' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Roku exception / console output -> Everframe crash frames.

function EfF_ExceptionType(number as dynamic) as string
    if number = invalid then return "RuntimeError"
    return "RuntimeError(&h" + UCase(StrI(number, 16)) + ")"
end function

' e.backtrace is outermost call first; Everframe frames are innermost first.
function EfF_FromBacktrace(backtrace as dynamic) as object
    frames = []
    if type(backtrace) <> "roArray" then return frames
    for i = backtrace.Count() - 1 to 0 step -1
        b = backtrace[i]
        sig = b["function"]
        if sig = invalid then sig = "<unknown>"
        name = sig
        p = Instr(1, sig, "(")
        if p > 1 then name = Left(sig, p - 1)
        file = b["filename"]
        line = b["line_number"]
        raw = sig
        if file <> invalid then raw = raw + " at " + file
        if line <> invalid then raw = raw + "(" + line.ToStr() + ")"
        f = { raw: EfU_Truncate(raw, 1024) }
        f["function"] = EfU_Truncate(name, 512)
        if file <> invalid then f.file = EfU_Truncate(file, 1024)
        if line <> invalid and line >= 0 then f.line = line
        frames.Push(f)
        if frames.Count() >= 256 then exit for
    end for
    return frames
end function

' Parses Roku's uncaught-error console text:
'   <message> (runtime error &hXX) in pkg:/path.brs(N)
'   Backtrace:
'   #1  Function name(...) As T
'      file/line: pkg:/path.brs(N)
' Returns invalid when no "(runtime error" header is present.
function EfF_ParseConsoleLog(log as dynamic) as dynamic
    if log = invalid or GetInterface(log, "ifString") = invalid then return invalid
    headRe = CreateObject("roRegex", "^(.*)\(runtime error &h([0-9a-fA-F]+)\) in (pkg:/[^(]+)\((\d+)\)", "")
    fnRe = CreateObject("roRegex", "^#\d+\s+Function\s+([^(\s]+)\(", "i")
    locRe = CreateObject("roRegex", "file/line:\s*(pkg:/[^(]+)\((\d+)\)", "i")
    result = invalid
    pendingFn = invalid
    for each rawLine in log.Tokenize(Chr(10))
        ln = rawLine.Trim()
        if result = invalid then
            m = headRe.Match(ln)
            if m.Count() = 5 then
                result = { number: Val(m[2], 16), message: m[1].Trim(), frames: [], file: m[3], line: Val(m[4], 10) }
            end if
        else
            m = fnRe.Match(ln)
            if m.Count() = 2 then
                pendingFn = m[1]
            else
                m = locRe.Match(ln)
                if m.Count() = 3 and pendingFn <> invalid then
                    f = { raw: pendingFn + " at " + m[1] + "(" + m[2] + ")", file: m[1], line: Val(m[2], 10) }
                    f["function"] = pendingFn
                    result.frames.Push(f)
                    pendingFn = invalid
                end if
            end if
        end if
    end for
    if result = invalid then return invalid
    if result.frames.Count() = 0 then
        result.frames.Push({ raw: result.file + "(" + result.line.ToStr() + ")", file: result.file, line: result.line })
    end if
    return { number: result.number, message: result.message, frames: result.frames }
end function
