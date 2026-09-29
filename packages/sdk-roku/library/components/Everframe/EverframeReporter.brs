' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Owns all network I/O. On start: Path B exit check, then drain the queue.
' Afterwards it sleeps until `flush` is set, or until a retry backoff expires.

sub init()
    m.top.functionName = "EfRep_Run"
end sub

sub EfRep_Run()
    port = CreateObject("roMessagePort")
    m.top.observeField("flush", port)
    m.sec = CreateObject("roRegistrySection", "Everframe")
    m.seen = {}
    backoff = 0
    try
        m.ctx = EfE_Context(EF_VERSION())
        EfRep_CheckLastExit()
    catch e
        print "[everframe] startup check failed: "; e.message
    end try
    while true
        retry = false
        try
            retry = EfRep_Drain()
        catch e
            print "[everframe] drain failed: "; e.message
            retry = true
        end try
        if retry then
            if backoff = 0 then backoff = 5000 else backoff = backoff * 2
            if backoff > 300000 then backoff = 300000
            wait(backoff, port)
        else
            backoff = 0
            wait(0, port)
        end if
    end while
end sub

sub EfRep_CheckLastExit()
    am = CreateObject("roAppManager")
    if FindMemberFunction(am, "GetLastExitInfo") = invalid then return
    EfX_Process(m.sec, am.GetLastExitInfo())
end sub

' Returns true when records remain that should be retried later.
function EfRep_Drain() as boolean
    for each item in EfQ_List(m.sec)
        env = EfE_Build(item.rec, m.ctx, EfU_NowMs())
        if not EfQ_Allow(m.sec, env.payload.crash.fingerprint, EfU_NowMs(), m.seen) then
            EfQ_Remove(m.sec, item.key)
        else
            status = EfRep_Post(env)
            if status >= 200 and status < 300 then
                EfQ_Remove(m.sec, item.key)
            else if status >= 400 and status < 500 and status <> 429 then
                ' Bad key, suspended org or malformed report: retrying cannot help.
                print "[everframe] report rejected: HTTP "; status
                EfQ_Remove(m.sec, item.key)
            else
                return true
            end if
        end if
    end for
    return false
end function

function EfRep_Post(env as object) as integer
    cfg = m.top.config
    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetUrl(cfg.endpoint + "/api/ingest")
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    boundary = EfM_Boundary()
    xfer.AddHeader("Authorization", "Bearer " + cfg.sdkKey)
    xfer.AddHeader("Content-Type", "multipart/form-data; boundary=" + boundary)
    if not xfer.AsyncPostFromString(EfM_Body(FormatJson(env), boundary)) then return 0
    msg = wait(15000, port)
    if type(msg) = "roUrlEvent" then return msg.GetResponseCode()
    xfer.AsyncCancel()
    return 0
end function
