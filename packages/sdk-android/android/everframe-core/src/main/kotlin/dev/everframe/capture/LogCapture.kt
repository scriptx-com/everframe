// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public log-capture install surface. Mirrors iOS `LogCapture.swift` +
// `StderrIntercept.swift` (PATTERNS lines 348-368).
//
// Two complementary tap paths — both producers feed `sharedLogBuffer`:
//
//   1. **Timber Tree** (when Timber is on classpath) — plants a no-op-on-host
//      Tree subclass that mirrors every Timber.{v,d,i,w,e} call into the ring
//      buffer. Detection runs through TimberDetector.timberOnClasspath() so
//      Timber-less apps still load this class without NoClassDefFoundError.
//
//   2. **System.out / System.err PrintStream wrap** — the JVM-equivalent of
//      iOS' stderr `dup2` intercept. Customer code that uses `println(...)`,
//      `System.err.println(...)`, or anything routed through the standard
//      streams is mirrored too. The original streams are preserved verbatim
//      so `adb logcat`, IDE consoles, and test runners still see the writes.
//
// Idempotency contract (PATTERNS "Shared Patterns / Idempotent install/uninstall"):
//   • install() is safe to call any number of times — only the first call has
//     observable side effects. The object monitor serializes complete stream
//     swaps/restoration, so teardown cannot leave an in-flight install orphaned.
//   • uninstall() is symmetrically safe — only the first transition out of
//     installed state runs the teardown.
//   • uninstall() preserves host trees and output. It revokes and removes only
//     this installation's exact SDK tree. An uncertain removal retains that
//     inactive handle and prevents new tree planting until removal succeeds.
//
// Wave-3 file-ownership: this plan does NOT touch Everframe.kt. Plan 05-06
// (Wave 4) is the sole writer that wires `LogCapture.install()` from
// Everframe.start()'s detached coroutine and `LogCapture.uninstall()` from
// Everframe.kill().
package dev.everframe.capture

import dev.everframe.envelope.txGuard
import dev.everframe.envelope.txGuardVoid
import java.io.PrintStream
import java.util.concurrent.atomic.AtomicBoolean

internal object LogCapture {

    private val installed = AtomicBoolean(false)
    private var savedOut: PrintStream? = null
    private var savedErr: PrintStream? = null
    private var activeCapture: AtomicBoolean? = null
    private var logOwner: Long? = null
    private var breadcrumbOwner: Long? = null
    // Any keeps Timber optional at class loading. A failed removal retains this sole handle.
    private var ownedTimberTree: Any? = null

    private fun retireTimberTree() {
        val tree = ownedTimberTree ?: return
        if (TimberDetector.removeTreeIfAvailable(tree)) ownedTimberTree = null
    }

    /**
     * Install both tap paths. Idempotent — second and subsequent calls are
     * no-ops while the same evidence generation remains active.
     */
    @Synchronized
    fun install() {
        installOwned(sharedLogBuffer.generation(), sharedBreadcrumbBuffer.generation())
    }

    // Caller owns this monitor. Captured destination generations never change for these producers;
    // admitted callbacks may finish after uninstall, but both rings reject their obsolete insertions.
    private fun installOwned(logs: Long, crumbs: Long) {
        if (installed.get() && (logOwner != logs || breadcrumbOwner != crumbs)) uninstall()
        if (!installed.compareAndSet(false, true)) return
        logOwner = logs
        breadcrumbOwner = crumbs
        val active = AtomicBoolean(true)
        activeCapture = active

        // 1) Timber Tree (gated on classpath). A failure to plant must NOT
        //    abort the rest of install — System.out/err wrap is the more
        //    universal path and is independent.
        txGuardVoid("LogCapture.installTimber") {
            retireTimberTree()
            if (ownedTimberTree == null && TimberDetector.timberOnClasspath()) {
                val tree = buildEverframeTree(active, logs, crumbs)
                ownedTimberTree = tree
                TimberDetector.installTreeIfAvailable(tree)
            }
        }

        // 2) System.out / System.err wrap. Save originals first so uninstall
        //    can put them back exactly. We capture the actual JVM streams,
        //    NOT whatever might already be wrapped by another SDK — when we
        //    uninstall we restore the snapshot we took, which is the
        //    documented contract (last-installer-wins-on-uninstall).
        savedOut = System.out
        savedErr = System.err
        System.setOut(TeePrintStream(savedOut!!) { line ->
            if (!active.get()) return@TeePrintStream
            sharedLogBuffer.push(
                LogRingBuffer.Entry(
                    timestamp = System.currentTimeMillis(),
                    level = "INFO",
                    tag = null,
                    message = line,
                ), logs
            )
            // Task 11 dual-write — passive, gated by sharedBreadcrumbBuffer itself.
            ConsoleBreadcrumbAdapter.dualWrite(rawLevel = "INFO", message = line, owner = crumbs)
        })
        System.setErr(TeePrintStream(savedErr!!) { line ->
            if (!active.get()) return@TeePrintStream
            sharedLogBuffer.push(
                LogRingBuffer.Entry(
                    timestamp = System.currentTimeMillis(),
                    level = "ERROR",
                    tag = null,
                    message = line,
                ), logs
            )
            // Task 11 dual-write — passive, gated by sharedBreadcrumbBuffer itself.
            ConsoleBreadcrumbAdapter.dualWrite(rawLevel = "ERROR", message = line, owner = crumbs)
        })
    }

    /**
     * Host-preserving teardown. Revokes and removes only our exact tree, then restores
     * saved PrintStreams. Failed removal retains the inactive handle; no replacement piles up.
     */
    @Synchronized
    fun uninstall() {
        if (!installed.compareAndSet(true, false)) return
        // A host may retain our tee or tree. Revoke this installation's producers permanently: a later
        // install receives its own token and cannot reactivate the old ones.
        activeCapture?.set(false)
        activeCapture = null
        retireTimberTree()
        savedOut?.let { System.setOut(it) }
        savedErr?.let { System.setErr(it) }
        savedOut = null
        savedErr = null
    }

    /**
     * Serialize the epoch check with the complete logging transition. Callers
     * must supply a lock-free predicate: no facade state lock is acquired here.
     * An epoch change during install is followed by the newer transition on
     * this same monitor; an already obsolete transition does nothing.
     */
    @Synchronized
    fun configure(enabled: Boolean, owner: Long? = null, isCurrent: () -> Boolean) {
        if (!isCurrent()) return
        if (enabled) {
            if (owner == null) install() else installOwned(owner, owner)
        } else uninstall()
    }

    /** Test-only — exposed for LogCaptureTest to assert install state. */
    internal fun isInstalledForTest(): Boolean = installed.get()

    /**
     * Build a Timber Tree subclass that mirrors emissions into sharedLogBuffer.
     *
     * Direct subclass of `timber.log.Timber.Tree` is safe here because every
     * call site of buildEverframeTree() is gated by
     * `TimberDetector.timberOnClasspath()`. compileOnly keeps the symbol off
     * the production runtime classpath; testImplementation supplies it for
     * unit tests.
     */
    private fun buildEverframeTree(active: AtomicBoolean, logs: Long, crumbs: Long): timber.log.Timber.Tree =
        object : timber.log.Timber.Tree() {
            override fun log(priority: Int, tag: String?, message: String, t: Throwable?) {
                if (!active.get()) return
                txGuardVoid("LogCapture.timberTree.log") {
                    val level = priorityToLevel(priority)
                    sharedLogBuffer.push(
                        LogRingBuffer.Entry(
                            timestamp = System.currentTimeMillis(),
                            level = level,
                            tag = tag,
                            message = message,
                        ), logs
                    )
                    // Task 11 dual-write — passive, gated by sharedBreadcrumbBuffer itself.
                    ConsoleBreadcrumbAdapter.dualWrite(rawLevel = level, message = message, owner = crumbs)
                }
            }
        }

    /** Map android.util.Log priority constants to Everframe log levels. */
    private fun priorityToLevel(priority: Int): String = when (priority) {
        2 -> "VERBOSE"   // Log.VERBOSE
        3 -> "DEBUG"     // Log.DEBUG
        4 -> "INFO"      // Log.INFO
        5 -> "WARN"      // Log.WARN
        6 -> "ERROR"     // Log.ERROR
        7 -> "ASSERT"    // Log.ASSERT
        else -> "INFO"
    }
}

/**
 * PrintStream that mirrors writes to (a) the original delegate and (b) a
 * line-oriented `onLine` callback. Bytes are accumulated until a newline is
 * observed; the callback receives the line WITHOUT the trailing '\n'.
 *
 * Multi-byte safety: we accumulate raw bytes via a ByteArrayOutputStream-style
 * StringBuilder of chars. Java's PrintStream is itself byte-oriented — the
 * platform-level `System.out.println` ultimately calls `write(byte[])`, so we
 * override both the byte and the byte-array forms.
 *
 * Concurrency: PrintStream subclasses inherit a synchronized base. We rely on
 * that — the `sb` builder is touched only inside the synchronized write paths
 * of the parent class, so no extra lock is needed.
 */
internal class TeePrintStream(
    private val delegate: PrintStream,
    private val onLine: (String) -> Unit,
) : PrintStream(delegate) {

    private val sb = StringBuilder()

    override fun write(b: Int) {
        delegate.write(b)
        txGuardVoid("TeePrintStream.write") {
            if (b == '\n'.code) {
                onLine(sb.toString())
                sb.setLength(0)
            } else if (b != '\r'.code) {
                // skip bare CR — `\r\n` line endings collapse to a single emission
                sb.append(b.toChar())
            }
        }
    }

    override fun write(buf: ByteArray, off: Int, len: Int) {
        delegate.write(buf, off, len)
        txGuardVoid("TeePrintStream.writeBuf") {
            var i = off
            val end = off + len
            while (i < end) {
                val b = buf[i].toInt() and 0xFF
                if (b == '\n'.code) {
                    onLine(sb.toString())
                    sb.setLength(0)
                } else if (b != '\r'.code) {
                    sb.append(b.toChar())
                }
                i++
            }
        }
    }

    override fun flush() {
        delegate.flush()
    }

    /**
     * Drain any partial line. Plan 05-06 may invoke this from EnvelopeBuilder
     * before snapshot to capture trailing output that lacks a final newline.
     */
    fun drainPartial() {
        txGuard("TeePrintStream.drainPartial") {
            if (sb.isNotEmpty()) {
                onLine(sb.toString())
                sb.setLength(0)
            }
        }
    }
}
