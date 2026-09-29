' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' The ingest wire format: multipart/form-data, one part named "envelope".
' BrightScript cannot gzip; ingest detects gzip by magic bytes, so plain JSON is fine.

function EfM_Boundary() as string
    return "everframe" + EfU_NowMs().ToStr()
end function

function EfM_Body(envelopeJson as string, boundary as string) as string
    crlf = Chr(13) + Chr(10)
    q = Chr(34)
    return "--" + boundary + crlf + "Content-Disposition: form-data; name=" + q + "envelope" + q + "; filename=" + q + "envelope.json" + q + crlf + "Content-Type: application/json" + crlf + crlf + envelopeJson + crlf + "--" + boundary + "--" + crlf
end function
