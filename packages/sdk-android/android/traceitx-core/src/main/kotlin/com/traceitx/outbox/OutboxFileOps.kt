// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
package com.traceitx.outbox

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.RandomAccessFile

internal interface OutboxFileOps {
    fun syncFile(file: File)
    fun renameAtomic(from: File, to: File)
    fun syncDirectory(dir: File)
}

/** Android API 24 compatible; a failed atomic operation never deletes its destination. */
internal class AndroidOutboxFileOps : OutboxFileOps {
    override fun syncFile(file: File) { RandomAccessFile(file, "rw").use { it.fd.sync() } }
    override fun renameAtomic(from: File, to: File) { Os.rename(from.path, to.path) }
    override fun syncDirectory(dir: File) {
        val fd = Os.open(dir.path, OsConstants.O_RDONLY, 0)
        try { Os.fsync(fd) } finally { Os.close(fd) }
    }
}
