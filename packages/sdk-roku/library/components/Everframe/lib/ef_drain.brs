' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' Queue drain, kept free of SceneGraph so it can be unit-tested. `post` is a
' function reference called as `status = post(env)` (HTTP status, 0 on
' network failure). `state` = { seen: {}, allowed: {} } persists across drains.

' Returns true when records remain that should be retried later. The crash-loop
' guard is charged once per record (state.allowed), not once per attempt.
' With no device/app context (ctx invalid) nothing is sent or removed: a record
' only counts as unbuildable when the context is known to be good.
function EfD_Drain(sec as object, ctx as dynamic, state as object, post as function) as boolean
    if type(ctx) <> "roAssociativeArray" then return true
    retry = false
    for each item in EfQ_List(sec)
        env = invalid
        try
            env = EfE_Build(item.rec, ctx, EfU_NowMs())
        catch e
            print "[everframe] dropping unbuildable record: "; e.message
        end try
        if env = invalid then
            EfQ_Remove(sec, item.key)
        else
            send = state.allowed.DoesExist(item.key)
            if not send then
                send = EfQ_Allow(sec, env.payload.crash.fingerprint, EfU_NowMs(), state.seen)
                if send then state.allowed[item.key] = true
            end if
            if not send then
                EfQ_Remove(sec, item.key)
            else
                status = post(env)
                if status >= 200 and status < 300 then
                    EfQ_Remove(sec, item.key)
                    state.allowed.Delete(item.key)
                else if status >= 400 and status < 500 and status <> 429 then
                    ' Bad key, suspended org or malformed report: retrying cannot help.
                    print "[everframe] report rejected: HTTP "; status
                    EfQ_Remove(sec, item.key)
                    state.allowed.Delete(item.key)
                else
                    retry = true
                    ' Status 0 = no network: the rest of this cycle would fail the same way.
                    if status = 0 then exit for
                end if
            end if
        end if
    end for
    return retry
end function
