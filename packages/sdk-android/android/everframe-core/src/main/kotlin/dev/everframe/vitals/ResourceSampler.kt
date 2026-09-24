// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// One 20s tick on the vitals HandlerThread (spec 2026-09-05 §2).
//   cpu  = Process.getElapsedCpuTime() delta / wall delta  (fraction of one core; absent on the first tick after start/resume)
//   mem  = Debug.getPss() in BYTES. NOT ActivityManager.getProcessMemoryInfo — Android 10+ rate-limits it to one real
//          reading per 5 minutes and returns stale values in between.
//   extras = { javaHeap, nativeHeap }
//
// `open` — Task 11's ResourceSamplerTest analog subclasses this anonymously, and
// VitalsControllerTest overrides start()/stop() to drive Codex round-2 Critical 2
// (an enable tail superseded mid-flight must stop what it just started).
package dev.everframe.vitals

import android.os.Debug
import android.os.Handler
import dev.everframe.envelope.txGuardVoid
import dev.everframe.vitals.wire.VitalsSample

open class ResourceSampler(
    private val handler: Handler,
    private val intervalMs: Long = 20_000,
    private val now: () -> Long = System::currentTimeMillis,
    private val readCpuTimeMs: () -> Long = { android.os.Process.getElapsedCpuTime() },
    private val readPssBytes: () -> Long = { Debug.getPss() * 1024 },
    private val readJavaHeap: () -> Long = { Runtime.getRuntime().let { it.totalMemory() - it.freeMemory() } },
    private val readNativeHeap: () -> Long = { Debug.getNativeHeapAllocatedSize() },
    private val onSample: (VitalsSample) -> Unit,
    private val onTick: () -> Unit,
) {
    // @Volatile: entry/repost checks below run on the vitals HandlerThread, while
    // start/pause/resume/stop mutate these from the caller's thread (main, via the
    // lifecycle observer). Plain vars risk the tick thread never observing a write.
    @Volatile private var running = false
    @Volatile private var paused = false
    @Volatile private var stopped = false
    private var lastCpuMs: Long? = null
    private var lastWallMs: Long? = null

    private val tick = object : Runnable {
        override fun run() {
            if (!running || paused || stopped) return
            txGuardVoid("ResourceSampler.tick") { sampleOnce() }
            txGuardVoid("ResourceSampler.onTick") { onTick() }
            // Synchronized on the same monitor as pause()/stop(): without this, a tick
            // already past the entry check above can race pause()'s flag-write +
            // removeCallbacks and repost anyway, silently resuming the cadence.
            synchronized(this@ResourceSampler) {
                if (running && !paused && !stopped) handler.postDelayed(this, intervalMs)
            }
        }
    }

    private fun sampleOnce() {
        val t = now()
        val cpuNow = readCpuTimeMs()
        val cpu: Double? = lastCpuMs?.let { prevCpu ->
            val wall = t - (lastWallMs ?: t)
            if (wall > 0) ((cpuNow - prevCpu).toDouble() / wall).coerceAtLeast(0.0) else null
        }
        lastCpuMs = cpuNow
        lastWallMs = t
        val sample = VitalsSample(
            t = t,
            cpu = cpu,
            mem = readPssBytes().coerceAtLeast(0),
            extras = mapOf("javaHeap" to readJavaHeap().toDouble(), "nativeHeap" to readNativeHeap().toDouble()),
        )
        onSample(sample)
    }

    @Synchronized open fun start() {
        if (stopped || running) return
        running = true
        handler.postDelayed(tick, intervalMs)
    }

    @Synchronized open fun pause() {
        if (!running || paused) return
        paused = true
        handler.removeCallbacks(tick)
    }

    @Synchronized open fun resume() {
        if (!running || !paused || stopped) return
        paused = false
        lastCpuMs = null
        lastWallMs = null
        handler.postDelayed(tick, intervalMs)
    }

    @Synchronized open fun stop() {
        stopped = true
        running = false
        handler.removeCallbacks(tick)
    }
}
