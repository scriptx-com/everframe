// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package dev.everframe.crash

import dev.everframe.outbox.OutboxFileOps
import java.io.File
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.attribute.PosixFilePermissions

/** Owns only UUID-named native directories; never walks or deletes through a symlink. */
@androidx.annotation.RequiresApi(26)
internal class AndroidNativeSignalFiles(base: File, private val ops: OutboxFileOps) {
    private val epochPattern = Regex("[0-9a-f]{32}")
    val root = directory(directory(base.canonicalFile, "dev.everframe"), "native-signal-v1")
    val records = directory(root, "records")
    private fun directory(parent: File, name: String): File {
        val child = File(parent, name); val path = child.toPath()
        if (!Files.exists(path, NOFOLLOW_LINKS)) {
            try {
                Files.createDirectory(path, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")))
                ops.syncDirectory(parent)
            } catch (_: FileAlreadyExistsException) {
                // The SDK outbox creates the shared parent on its own thread; the check below decides.
            }
        }
        check(Files.isDirectory(path, NOFOLLOW_LINKS) && !Files.isSymbolicLink(path)) { "Native directory must be owned and regular" }
        return child
    }
    private fun entries(dir: File, max: Int): List<File> = Files.newDirectoryStream(dir.toPath()).use { stream ->
        val result = ArrayList<File>()
        for (path in stream) { check(result.size < max) { "Native directory exceeds bound" }; result.add(path.toFile()) }
        result
    }
    fun prepare(epoch: String) {
        require(epoch.matches(epochPattern))
        check(entries(records, 16).size < 16) { "Native record capacity" }
        directory(records, epoch)
    }
    fun read(epoch: String): ByteArray? {
        require(epoch.matches(epochPattern))
        val dir = File(records, epoch)
        if (!Files.exists(dir.toPath(), NOFOLLOW_LINKS)) return null
        check(Files.isDirectory(dir.toPath(), NOFOLLOW_LINKS) && !Files.isSymbolicLink(dir.toPath()))
        return AndroidNativeRecordReader.readFile(File(dir, epoch))
    }
    fun cleanup(retainedEpochs: Set<String>) {
        for (dir in entries(records, 64)) {
            check(dir.name.matches(epochPattern) && Files.isDirectory(dir.toPath(), NOFOLLOW_LINKS) && !Files.isSymbolicLink(dir.toPath()))
            if (dir.name in retainedEpochs) continue
            for (file in entries(dir, 4)) {
                check(file.name in setOf("authority", dir.name, dir.name + ".partial"))
                check(Files.isRegularFile(file.toPath(), NOFOLLOW_LINKS) && !Files.isSymbolicLink(file.toPath()))
                Files.delete(file.toPath())
            }
            Files.delete(dir.toPath())
        }
        ops.syncDirectory(records)
    }
}
