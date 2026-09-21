// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Task 11 (Kotlin mirror of iOS Task 7) — converts platform events into
// `.console` / `.network` / `.lifecycle` / `.error` breadcrumbs. Mirrors the
// web bridge's binding mappings EXACTLY (Plan 2 Task 4 — source of truth):
//   - console: packages/sdk-react/src/capture/logs.ts:133
//     `crumb({ kind: 'console', level: CRUMB_LEVEL[l], message })`.
//   - network: packages/sdk-react/src/capture/network.ts:19 (shape) and
//     :26-28 (`statusLevel`: status===0 -> error, >=500 -> error, >=400 ->
//     warn, else info). Android's `status == null` (IOException before a
//     response arrived) is the analogue of web's `status === 0`.
//
// Console/network are PASSIVE dual-writes: `ConsoleBreadcrumbAdapter` and
// `NetworkBreadcrumbAdapter` are called directly from the existing capture
// call sites (LogCapture.kt, TraceItXInterceptor.kt) — nothing here needs an
// "install" step for those two kinds. Lifecycle + error ARE installed (once)
// from `TraceItX.start(context, config)`, after the kill-gate is set. All
// four adapters rely on `BreadcrumbRingBuffer.add` (via `sharedBreadcrumbBuffer`)
// for their actual gating (kill-switch + live per-kind config, Task 1/5/9) —
// the `isKindEnabled` pre-checks below are a hot-path optimization only (skip
// building the crumb when the kind is off), never the source of correctness.
//
// Never crash the host: every adapter body is wrapped in `txGuardVoid` so a
// failure here can never propagate into the caller's println/Timber log
// line, OkHttp call, lifecycle callback, or (most importantly) the crashing
// thread's uncaught-exception unwind.
//
// Redaction note (differs from iOS): the console dual-write sites in
// LogCapture.kt pass the RAW `line`/`message` (unlike iOS's pre-redacted
// message) — `sharedBreadcrumbBuffer.add` redacts message + data at add-time
// (Task 9's MASK-BEFORE-BYTES doctrine), so passing the raw string straight
// through is correct and avoids redacting twice.
package com.traceitx.capture

import android.content.Context
import androidx.annotation.VisibleForTesting
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.traceitx.crash.CrashReporter
import com.traceitx.envelope.txGuardVoid
import com.traceitx.protocol.generated.BreadcrumbKind
import com.traceitx.protocol.generated.Level
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.atomic.AtomicBoolean

// ---------------- Console (kind: .console) ----------------

/**
 * Dual-write adapter for the console tap paths in `LogCapture.kt` (System.out
 * tee, System.err tee, Timber tree — THREE push sites, all must call
 * [dualWrite]).
 */
internal object ConsoleBreadcrumbAdapter {

    /**
     * Maps a `LogRingBuffer.Entry.level` string (this SDK's own vocabulary —
     * see `LogCapture.priorityToLevel` for the exact output set: "VERBOSE" |
     * "DEBUG" | "INFO" | "WARN" | "ERROR" | "ASSERT", plus the tee sites'
     * literal "INFO" / "ERROR") to the protocol [Level]. "ASSERT" (Log.wtf(),
     * priority 7) is Android's highest severity — strictly more severe than
     * "ERROR" — and has no web/iOS analogue, so it promotes to `.error` per
     * the cross-SDK "more-severe-wins" rule (mirrors iOS's platform-only
     * "fault" -> .error promotion). Any other unrecognized string falls back
     * to `.info` rather than being dropped — a crumb with a slightly-wrong
     * level is far better than a silently-lost console line.
     *
     * Console-level fidelity is platform-inherent: iOS stderr-sourced
     * console crumbs are always `.info` (stderr carries no level); Android
     * Timber-sourced crumbs carry real priorities (VERBOSE..ASSERT), mapped
     * below.
     */
    internal fun mapLevel(raw: String): Level = when (raw) {
        "INFO" -> Level.Info
        "WARN" -> Level.Warn
        "ERROR" -> Level.Error
        // Log.ASSERT (Log.wtf(), priority 7) is Android's highest severity —
        // strictly more severe than ERROR — so it promotes to Level.Error,
        // matching iOS's "more-severe-wins" rule for its platform-only
        // "fault" level (BreadcrumbAdapters.swift:49-56).
        "ASSERT" -> Level.Error
        "DEBUG", "VERBOSE" -> Level.Debug
        else -> Level.Info
    }

    /**
     * Dual-write call site — invoked immediately after
     * `sharedLogBuffer.push(...)` at each of LogCapture.kt's three push
     * sites, passing the SAME raw level string + message. The `isKindEnabled`
     * short-circuit avoids minting a crumb at all when console breadcrumbs
     * are off on this hot path; `add` itself would no-op anyway (belt and
     * suspenders — correctness lives in `add`, not here).
     */
    fun dualWrite(rawLevel: String, message: String, owner: Long? = null) {
        txGuardVoid("ConsoleBreadcrumbAdapter.dualWrite") {
            if (!sharedBreadcrumbBuffer.isKindEnabled(BreadcrumbKind.Console)) return@txGuardVoid
            if (owner == null) sharedBreadcrumbBuffer.add(kind = BreadcrumbKind.Console, message = message, level = mapLevel(rawLevel))
            else sharedBreadcrumbBuffer.addOwned(BreadcrumbKind.Console, message, mapLevel(rawLevel), owner)
        }
    }
}

// ---------------- Network (kind: .network) ----------------

internal data class NetworkCrumbMapped(val message: String, val level: Level, val data: JsonObject)

/**
 * Dual-write adapter for the two `sharedNetworkBuffer.push(...)` call sites
 * in `TraceItXInterceptor.kt` (success + IOException).
 */
internal object NetworkBreadcrumbAdapter {

    /**
     * Pure mapping helper — mirrors sdk-react network.ts's `statusLevel`
     * (status===0 -> error; >=500 -> error; >=400 -> warn; else info). A
     * `null` status (IOException — request failed before a response
     * arrived) is Android's analogue of web's `status === 0` and maps the
     * same way. `url` is expected ALREADY redacted by the caller
     * (`TraceItXInterceptor` redacts at capture time via `RedactionEngine`);
     * this function does not redact again.
     */
    internal fun map(method: String, url: String, status: Int?, durationMs: Long): NetworkCrumbMapped {
        val message: String
        val level: Level
        if (status != null) {
            message = "$method $url $status"
            level = if (status >= 500) Level.Error else if (status >= 400) Level.Warn else Level.Info
        } else {
            message = "$method $url failed"
            level = Level.Error
        }
        val data = BreadcrumbRingBuffer.coerceHostData(
            mapOf(
                "method" to method,
                "url" to url,
                "status" to status,
                "durationMs" to durationMs,
            ),
        )
        return NetworkCrumbMapped(message, level, data)
    }

    /**
     * Dual-write call site — invoked immediately after
     * `sharedNetworkBuffer.push(entry)` at both of TraceItXInterceptor.kt's
     * push sites, from the same already-built `NetworkRingBuffer.Entry`
     * (its `url` is already redacted; `status` is null on the IOException
     * path). `reqId` (spec network-body-capture) is the id minted for a
     * just-buffered payload entry, correlating this crumb with its row in
     * `NetworkBodyRingBuffer`; `null` (the default) when no payload was
     * captured for this request — the crumb's `data` then has no `reqId`
     * key at all, matching pre-body-capture behavior exactly.
     */
    fun dualWrite(entry: NetworkRingBuffer.Entry, reqId: Int? = null, owner: Int? = null) {
        txGuardVoid("NetworkBreadcrumbAdapter.dualWrite") {
            if (!sharedBreadcrumbBuffer.isKindEnabled(BreadcrumbKind.Network)) return@txGuardVoid
            val mapped = map(entry.method, entry.url, entry.status, entry.durationMs)
            val data = if (reqId != null) {
                JsonObject(mapped.data + BreadcrumbRingBuffer.coerceHostData(mapOf("reqId" to reqId)))
            } else {
                mapped.data
            }
            if (owner == null) sharedBreadcrumbBuffer.add(
                kind = BreadcrumbKind.Network, message = mapped.message, level = mapped.level, data = data,
            ) else sharedBreadcrumbBuffer.addOwned(BreadcrumbKind.Network, mapped.message, mapped.level, owner.toLong(), data)
        }
    }
}

// ---------------- Lifecycle (kind: .lifecycle) ----------------

/**
 * Bridges `ProcessLifecycleOwner` foreground/background transitions into
 * `.lifecycle` crumbs. Pattern: `RelayWSClient`'s `DefaultLifecycleObserver`
 * registration (Companion/RelayWSClient.kt:103-131) — `addObserver()` MUST
 * run on the main thread (AndroidX contract), so `install()` marshals onto
 * main exactly like `RelayWSClient.start()` does. A single process-lifetime
 * `object` so install-once semantics hold across repeated `TraceItX.start()`
 * calls (mirrors `LogCapture.install()`'s idempotency).
 */
internal object LifecycleBreadcrumbObserver : DefaultLifecycleObserver {

    private val installed = AtomicBoolean(false)

    /** Test-only flag. */
    @VisibleForTesting
    internal fun installedForTesting(): Boolean = installed.get()

    fun install() {
        if (!installed.compareAndSet(false, true)) return
        runOnMain { ProcessLifecycleOwner.get().lifecycle.addObserver(this) }
    }

    /**
     * Test-only reset seam — lets BreadcrumbAdaptersTest re-drive `install()`
     * against a fresh subscription per test without leaking duplicate
     * observers across the (JVM-shared) test suite. Does NOT remove the
     * observer from ProcessLifecycleOwner (tests don't rely on that; they
     * drive `onStart`/`onStop` directly per the RelayWSClientTest pattern).
     */
    @VisibleForTesting
    internal fun __resetForTesting() {
        installed.set(false)
    }

    private fun runOnMain(block: () -> Unit) {
        val mainLooper = android.os.Looper.getMainLooper()
        if (android.os.Looper.myLooper() === mainLooper) {
            block()
        } else {
            android.os.Handler(mainLooper).post(block)
        }
    }

    override fun onStart(owner: LifecycleOwner) {
        txGuardVoid("LifecycleBreadcrumbObserver.onStart") {
            sharedBreadcrumbBuffer.add(
                kind = BreadcrumbKind.Lifecycle,
                message = "foreground",
                data = BreadcrumbRingBuffer.coerceHostData(mapOf("state" to "foreground")),
            )
        }
    }

    override fun onStop(owner: LifecycleOwner) {
        txGuardVoid("LifecycleBreadcrumbObserver.onStop") {
            sharedBreadcrumbBuffer.add(
                kind = BreadcrumbKind.Lifecycle,
                message = "background",
                data = BreadcrumbRingBuffer.coerceHostData(mapOf("state" to "background")),
            )
        }
    }
}

// ---------------- Error (kind: .error) ----------------

/**
 * Install-once wrapper around `Thread.setDefaultUncaughtExceptionHandler`,
 * CHAINING the previous handler (captured at install time and called LAST,
 * after our crumb has already landed) so any other exception handler (a host
 * crash reporter — Crashlytics, Bugsnag, Sentry — installed earlier) keeps
 * receiving every exception exactly as before we existed.
 *
 * HONEST LIMITATION (v1 scope): by the time this handler runs, the process is
 * dying. `sharedBreadcrumbBuffer.add` only appends to an in-memory ring
 * buffer — there is no best-effort synchronous disk persist here. The crumb
 * only survives to be shipped if the report flow runs in-process later (i.e.
 * a *previous* handler, or the OS, keeps the process alive long enough for a
 * host-triggered report to read the buffer — e.g. a caught/rethrown
 * scenario, or a non-fatal ANR-adjacent path). A true crash-time persist is
 * out of scope for v1 and is intentionally not attempted here.
 */
internal object ErrorBreadcrumbAdapter {

    private val installed = AtomicBoolean(false)

    /**
     * The handler registered before ours, captured at install time. Written
     * exactly once, inside the single-flight `install()` guard, strictly
     * before any crash can reach [handle] — so [handle] reads it without a
     * lock. Taking a lock during uncaught-exception unwinding would risk
     * deadlock (e.g. if the crash happened while some other code on this
     * thread already held that lock), which is exactly the one context where
     * this code must never block.
     */
    @Volatile
    private var previousHandler: Thread.UncaughtExceptionHandler? = null

    fun install() {
        if (!installed.compareAndSet(false, true)) return
        previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler(TraceItXUncaughtExceptionHandler)
    }

    /** Test-only reset seam. */
    @VisibleForTesting
    internal fun __resetForTesting() {
        installed.set(false)
        previousHandler = null
    }

    /** Test-only accessor. */
    @VisibleForTesting
    internal fun previousHandlerForTesting(): Thread.UncaughtExceptionHandler? = previousHandler

    /**
     * Builds + adds the `.error` crumb, then chains to [previousHandler]
     * LAST. Called both by [TraceItXUncaughtExceptionHandler] in production
     * and directly by tests (there is no headless way to trigger a real
     * process-wide uncaught exception from a JVM test runner). The crumb
     * construction is wrapped in `txGuardVoid` so a redaction/serialization
     * hiccup here can never prevent the chained handler from running; the
     * chained call itself is intentionally OUTSIDE the guard so any
     * exception a host's own handler throws is not our concern to swallow.
     */
    fun handle(thread: Thread, throwable: Throwable) {
        txGuardVoid("ErrorBreadcrumbAdapter.handle") {
            val stackDigest = throwable.stackTrace.take(10).joinToString("\n")
            val data = BreadcrumbRingBuffer.coerceHostData(
                mapOf(
                    "name" to throwable.javaClass.name,
                    "stackDigest" to stackDigest,
                ),
            )
            sharedBreadcrumbBuffer.add(
                kind = BreadcrumbKind.Error,
                message = throwable.message ?: throwable.javaClass.name,
                level = Level.Error,
                data = data,
            )
        }
        // Task 10 — synchronous crash persist, its OWN txGuardVoid so a
        // redaction/envelope/disk hiccup here can never prevent the chained
        // handler below from running. Deliberately between the crumb block
        // and the chain call, never inside either.
        txGuardVoid("ErrorBreadcrumbAdapter.crashReport") {
            CrashReporter.captureThrowable(thread, throwable)
        }
        previousHandler?.uncaughtException(thread, throwable)
    }
}

/**
 * Top-level singleton `Thread.UncaughtExceptionHandler` implementation —
 * registered via `Thread.setDefaultUncaughtExceptionHandler`. Delegates
 * immediately to [ErrorBreadcrumbAdapter.handle].
 */
private object TraceItXUncaughtExceptionHandler : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(t: Thread, e: Throwable) {
        ErrorBreadcrumbAdapter.handle(t, e)
    }
}

// ---------------- Install orchestrator ----------------

internal object BreadcrumbAdapters {
    /**
     * Wired from `TraceItX.start(context, config)`'s detached heavy-init
     * coroutine, immediately after the kill-gate is set (`captureGate =
     * true`). Install-once for both sub-adapters — safe across repeated
     * `start()` calls. Console/network need no install call here: they are
     * passive dual-writes firing from their existing capture call sites
     * (`LogCapture.kt`, `TraceItXInterceptor.kt`) and are gated purely by
     * `BreadcrumbRingBuffer`'s live per-kind config.
     *
     * Takes no config: `CrashReporter` stopped keeping its own copy when the
     * crash path moved to a crash-entry session snapshot, and nothing else here
     * ever read one. Passing it would only invite a second source of truth back.
     */
    fun install(context: Context) {
        txGuardVoid("BreadcrumbAdapters.install") {
            CrashReporter.configure(context)
            LifecycleBreadcrumbObserver.install()
            ErrorBreadcrumbAdapter.install()
        }
    }
}
