// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream, rmSync } from "node:fs";
import { mkdtemp, open, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { DSYM_MAX_BYTES, R8_MAX_BYTES } from "@everframe/protocol";

interface Identity {
  mapBytes: number;
  mapSha256: string;
}
const changed = () => new Error("source_map_changed");

// A signal ends the process without running finally blocks, so remove live
// snapshots and re-raise it. A host with its own handler keeps the signal;
// if that handler exits, the exit hook removes them.
const live = new Set<string>();
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
function hold(directory: string): void {
  if (!live.size) {
    for (const signal of signals) process.on(signal, interrupted);
    process.on("exit", removeLive);
  }
  live.add(directory);
}
function release(directory: string): void {
  live.delete(directory);
  if (live.size) return;
  for (const signal of signals) process.off(signal, interrupted);
  process.off("exit", removeLive);
}
function removeLive(): void {
  for (const directory of live) {
    release(directory);
    rmSync(directory, { recursive: true, force: true });
  }
}
function interrupted(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) > 1) return;
  try {
    removeLive();
  } finally {
    process.kill(process.pid, signal);
  }
}

// The caller has checked root containment. All subsequent reads use this one
// no-follow descriptor, so replacing a pathname cannot redirect the snapshot.
async function readChecked(
  path: string,
  identity: Identity,
  target?: FileHandle,
): Promise<void> {
  if (
    !Number.isSafeInteger(identity.mapBytes) ||
    identity.mapBytes <= 0 ||
    identity.mapBytes > Math.max(DSYM_MAX_BYTES, R8_MAX_BYTES)
  )
    throw changed();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw changed();
  });
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== identity.mapBytes) throw changed();
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const hash = createHash("sha256");
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.length, identity.mapBytes + 1 - length),
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > identity.mapBytes) throw changed();
      hash.update(chunk.subarray(0, bytesRead));
      if (target) {
        let written = 0;
        while (written < bytesRead) {
          const result = await target.write(
            chunk,
            written,
            bytesRead - written,
          );
          if (result.bytesWritten === 0) throw changed();
          written += result.bytesWritten;
        }
      }
    }
    if (
      length !== identity.mapBytes ||
      (await file.stat()).size !== length ||
      hash.digest("hex") !== identity.mapSha256
    )
      throw changed();
  } finally {
    await file.close();
  }
}

export async function verifyDsymFile(
  path: string,
  identity: Identity,
): Promise<void> {
  await readChecked(path, identity);
}

/**
 * A private copy of a checked large artifact, streamed for each attempt.
 * With `gzip`, the copy is compressed once so retries replay identical bytes
 * and the request carries an exact Content-Length.
 */
export async function snapshotArtifactFile(
  path: string,
  identity: Identity,
  options: { gzip?: boolean } = {},
) {
  const snapshot = await snapshotDsymFile(path, identity);
  if (!options.gzip) return { ...snapshot, bytes: identity.mapBytes, encoding: undefined };
  try {
    const compressed = snapshot.path + ".gz";
    await pipeline(
      createReadStream(snapshot.path, { highWaterMark: 64 * 1024 }),
      createGzip({ level: 6 }),
      createWriteStream(compressed, { flags: "wx", mode: 0o600 }),
    );
    await rm(snapshot.path, { force: true });
    const bytes = (await stat(compressed)).size;
    return {
      stream: () => createReadStream(compressed, { highWaterMark: 64 * 1024 }),
      dispose: snapshot.dispose,
      path: compressed,
      bytes,
      encoding: "gzip" as const,
    };
  } catch (error) {
    await snapshot.dispose();
    throw error;
  }
}

export async function snapshotDsymFile(path: string, identity: Identity) {
  const directory = await mkdtemp(join(tmpdir(), "everframe-dsym-upload-"));
  hold(directory);
  const dispose = async () => {
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      release(directory);
    }
  };
  const snapshot = join(directory, "artifact");
  try {
    const file = await open(snapshot, "wx", 0o600);
    try {
      await readChecked(path, identity, file);
    } finally {
      await file.close();
    }
    return {
      stream: () => createReadStream(snapshot, { highWaterMark: 64 * 1024 }),
      dispose,
      path: snapshot,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
