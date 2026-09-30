' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Client-side crash grouping key. Parity-locked with the TS/Kotlin/Swift SDKs
' by protocol/__tests__/fixtures/crash-fingerprint.json — change all or none.

function EfFp_Compute(exceptionType as string, frames as object) as string
    digits = CreateObject("roRegex", "[0-9]+", "")
    keys = []
    for i = 0 to frames.Count() - 1
        if i >= 5 then exit for
        f = frames[i]
        fn = f["function"]
        file = f["file"]
        if fn <> invalid and file <> invalid then
            keys.Push(fn + "|" + file)
        else
            keys.Push(digits.ReplaceAll(f["raw"], ""))
        end if
    end for
    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(exceptionType + Chr(10) + keys.Join(Chr(10)))
    digest = CreateObject("roEVPDigest")
    digest.Setup("sha256")
    return Left(digest.Process(bytes), 16)
end function
