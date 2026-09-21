// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Client-side crash grouping key (spec 2026-07-18). The rule is parity-locked
// across TS/Kotlin/Swift by protocol/__tests__/fixtures/crash-fingerprint.json
// — change it in all three places or not at all. Line/col digits are stripped
// so minor releases don't fragment groups; v2 server grouping may recompute.
import { sha256Hex } from './sha256.js';

export { sha256Hex };

const TOP_FRAMES = 5;

export function computeCrashFingerprint(
  exceptionType: string,
  frames: ReadonlyArray<{ raw: string; function?: string; file?: string }>,
): string {
  const keys = frames.slice(0, TOP_FRAMES).map((f) =>
    f.function != null && f.file != null ? `${f.function}|${f.file}` : f.raw.replace(/[0-9]+/g, ''),
  );
  return sha256Hex(`${exceptionType}\n${keys.join('\n')}`).slice(0, 16);
}
