' SPDX-License-Identifier: MIT
' SPDX-FileCopyrightText: 2026 ScriptX
'
' EfRecord + device/app context -> ReportEnvelope (protocol 1.0).

function EfE_Context(sdkVersion as string) as object
    di = CreateObject("roDeviceInfo")
    ai = CreateObject("roAppInfo")
    osVersion = ""
    if FindMemberFunction(di, "GetOSVersion") <> invalid then
        v = di.GetOSVersion()
        osVersion = v.major + "." + v.minor + "." + v.revision
    end if
    size = di.GetDisplaySize()
    locale = CreateObject("roRegex", "_", "").ReplaceAll(di.GetCurrentLocale(), "-")
    app = { name: ai.GetTitle(), version: ai.GetVersion() }
    build = ai.GetValue("build_version")
    if build <> invalid and build <> "" then app.build = build
    return {
        "sdkVersion": sdkVersion,
        app: app,
        device: { "osVersion": osVersion, model: di.GetModel(), width: size.w, height: size.h, locale: locale, timezone: di.GetTimeZone() }
    }
end function

function EfE_Build(rec as object, ctx as object, nowMs as dynamic) as object
    crash = {
        "exceptionType": EfU_Truncate(rec.exceptionType, 256),
        message: EfU_Truncate(rec.message, 4096),
        frames: rec.frames,
        mechanism: rec.mechanism,
        handled: rec.handled,
        fatal: rec.fatal,
        "occurredAt": EfU_IsoFromMs(rec.t),
        fingerprint: EfE_Fingerprint(rec)
    }
    if rec.thread <> invalid then crash["threadName"] = rec.thread
    details = {}
    if rec.context <> invalid then details.context = EfU_Truncate(rec.context, 256)
    metadata = EfE_Metadata(rec)
    if metadata <> invalid then details.metadata = metadata
    if details.Count() > 0 then crash.details = details

    crumbs = rec.crumbs
    if crumbs = invalid then crumbs = []
    source = "crash"
    if rec.handled then source = "error"
    reporter = { title: EfU_Truncate(crash.exceptionType + ": " + crash.message, 200), description: "" }
    if rec.user <> invalid then reporter.user = rec.user

    appVersion = ctx.app.version
    if rec.appVersion <> invalid then appVersion = rec.appVersion
    app = { name: ctx.app.name, version: appVersion }
    if ctx.app.build <> invalid then app.build = ctx.app.build

    context = {
        app: app,
        device: {
            os: "Roku OS",
            "osVersion": ctx.device.osVersion,
            model: ctx.device.model,
            "screenSize": { width: ctx.device.width, height: ctx.device.height },
            "pixelRatio": 1,
            locale: ctx.device.locale,
            timezone: ctx.device.timezone
        }
    }
    ' The screen the app was on (setScreen / instrumented init of a screen).
    route = rec.route
    if route <> invalid then
        if GetInterface(route, "ifString") <> invalid then
            if route <> "" then context["route"] = EfU_Truncate(route, 128)
        end if
    end if

    return {
        "protocolVersion": "1.0",
        "reportId": rec.id,
        "submittedAt": EfU_IsoFromMs(nowMs),
        source: source,
        sdk: { name: "everframe-roku", version: ctx.sdkVersion, platform: "roku", "formFactor": "tv" },
        reporter: reporter,
        captures: { screenshot: false, "uiTree": false, focus: false, logs: false, network: false, breadcrumbs: crumbs.Count() > 0 },
        "captureControl": { included: ["breadcrumbs"], excluded: ["screenshot", "uiTree", "focus", "logs", "network"], "degradedReason": "crash-capture" },
        payload: { crash: crash, breadcrumbs: crumbs },
        context: context,
        attachments: []
    }
end function

' details.metadata: a copy of the exit metadata (exitCode, memLimitMb, ...)
' plus "memory": { percent, limitMb? } when the record carries a reading.
function EfE_Metadata(rec as object) as dynamic
    meta = invalid
    if type(rec.exitInfo) = "roAssociativeArray" then
        meta = {}
        meta.Append(rec.exitInfo)
    end if
    mem = rec.memory
    if type(mem) = "roAssociativeArray" and EfU_IsNum(mem.percent) then
        if meta = invalid then meta = {}
        m2 = { "percent": mem.percent }
        if EfU_IsNum(mem.limitMb) then m2["limitMb"] = mem.limitMb
        meta["memory"] = m2
    end if
    return meta
end function

' The fingerprint EfQ_Fit stored before trimming; computed here only for a
' record that has none.
function EfE_Fingerprint(rec as object) as string
    fp = rec.fp
    if fp <> invalid and GetInterface(fp, "ifString") <> invalid and fp <> "" then return fp
    return EfFp_Compute(rec.exceptionType, rec.frames)
end function
