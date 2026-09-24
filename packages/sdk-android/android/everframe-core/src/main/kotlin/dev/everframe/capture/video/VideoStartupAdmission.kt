// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video

import android.content.Context
import android.os.Build
import java.io.File
import java.nio.file.DirectoryStream
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes

/** One executing and one latest startup; only the installed session may consume completion. */
internal class VideoStartupAdmission(
    private val scheduler: VideoCaptureScheduler = AndroidVideoCaptureScheduler,
    private val nowNanos: () -> Long = System::nanoTime,
    private val cleanup: (File, Long) -> Boolean = { root, began -> VideoDirectoryLeases.cleanStartup(root, startedNanos = began) },
) {
    private data class Request(val context: Context, val complete: (Boolean) -> Unit)
    private val lock = Any()
    private var pending: Request? = null
    private var running = false
    // Worker-confined, sticky for this process. A second root is never authorized by the first.
    private var attempted = false
    private var rootPath: String? = null
    private var allowed = false

    fun request(context: Context, complete: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < 29) { complete(false); return }
        val post = synchronized(lock) {
            pending = Request(context, complete)
            if (running) false else { running = true; true }
        }
        if (post) scheduler.worker(::run)
    }

    private fun run() {
        val request = synchronized(lock) { pending.also { pending = null } }!!
        val admitted = try {
            val began = nowNanos()
            val root = File(request.context.noBackupFilesDir, "everframe-video")
            if (!attempted) {
                attempted = true
                rootPath = root.absolutePath
                allowed = cleanup(root, began)
            }
            if (nowNanos() - began !in 0 until 100_000_000L) allowed = false
            allowed && root.absolutePath == rootPath
        } catch (_: Throwable) { attempted = true; allowed = false; false }
        try { request.complete(admitted) } finally {
            val again = synchronized(lock) {
                if (pending == null) { running = false; false } else true
            }
            if (again) scheduler.worker(::run)
        }
    }

    companion object { val process = VideoStartupAdmission() }
}

/** Filesystem boundary permits deterministic failed-stat/delete and slow-directory tests. */
internal interface VideoStartupFiles {
    fun attributes(path: Path): BasicFileAttributes
    fun entries(path: Path): DirectoryStream<Path>
    fun delete(path: Path): Boolean
}
internal object AndroidVideoStartupFiles : VideoStartupFiles {
    override fun attributes(path: Path): BasicFileAttributes = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
    override fun entries(path: Path): DirectoryStream<Path> = Files.newDirectoryStream(path)
    override fun delete(path: Path): Boolean { Files.delete(path); return true }
}

/** API29+, existing worker only. Neither filesystem work nor its waits hold the lease monitor. */
internal class VideoStartupCleaner(
    private val budget: VideoDiskBudget = VideoDiskBudget.process,
    private val files: VideoStartupFiles = AndroidVideoStartupFiles,
    private val nowNanos: () -> Long = System::nanoTime,
) {
    fun clean(root: File, startedNanos: Long = nowNanos()): Boolean {
        if (Build.VERSION.SDK_INT < 29 || !VideoDirectoryLeases.beginCleanup()) return false
        try {
            var examined = 0
            fun checkTime() { check(nowNanos() - startedNanos in 0 until 100_000_000L) }
            fun examine(path: Path): BasicFileAttributes {
                checkTime(); check(examined < 4096); examined++
                return files.attributes(path).also { checkTime(); check(!it.isSymbolicLink) }
            }
            // Pending deletion ownership must not be double charged or declared free.
            // Its existing owner retries on the worker; a new process discovers the file afresh.
            val probe = budget.reserve(0) ?: return false
            probe.close()
            val rootAttributes = try { examine(root.toPath()) } catch (_: NoSuchFileException) { checkTime(); return true }
            check(rootAttributes.isDirectory)
            fun scan(directory: Path, depth: Int) {
                checkTime()
                files.entries(directory).use { stream ->
                    val iterator = stream.iterator()
                    while (true) {
                        checkTime()
                        if (!iterator.hasNext()) break
                        checkTime(); check(examined < 4096)
                        val entry = iterator.next()
                        val attributes = examine(entry)
                        if (depth < 2) {
                            check(attributes.isDirectory && VideoDirectoryLeases.validId(entry.fileName.toString()))
                            scan(entry, depth + 1)
                            checkTime(); check(files.delete(entry)); checkTime()
                        } else {
                            check(attributes.isRegularFile && VideoDirectoryLeases.recognizedArtifact(entry.fileName.toString()))
                            val reservation = budget.reserve(0) ?: error("Pending video cleanup")
                            reservation.accountActual(attributes.size())
                            val owned = VideoOwnedFile(entry.toFile(), reservation, budget) { file ->
                                checkTime(); files.delete(file.toPath())
                            }
                            check(owned.delete()); checkTime()
                        }
                    }
                }
                checkTime()
            }
            scan(root.toPath(), 0)
            return true
        } catch (_: Throwable) {
            // Unknown entries, unreadable directories and exhausted work leave optional video off.
            return false
        } finally { VideoDirectoryLeases.endCleanup() }
    }
}
