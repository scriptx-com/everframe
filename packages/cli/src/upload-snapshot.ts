// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DSYM_MAX_BYTES } from "@everframe/protocol";

interface Identity {
  mapBytes: number;
  mapSha256: string;
}
const changed = () => new Error("source_map_changed");

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
    identity.mapBytes > DSYM_MAX_BYTES
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

export async function snapshotDsymFile(path: string, identity: Identity) {
  const directory = await mkdtemp(join(tmpdir(), "everframe-dsym-upload-"));
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
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
