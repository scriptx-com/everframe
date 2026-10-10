// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Build identity on Vega OS. The Vega CLI bundles with Metro, names the
// bundle by its SHA-256 (`<id>.bundle`, map `<id>.bundle.map`) and compiles
// bytecode that keeps JavaScript lines and columns, so a release frame reads
// `at fn (<build machine dir>/<id>.bundle:LINE:COL)`. The id is the build
// identity the uploaded map is registered under.
import type { JsBundleMetadata } from '@everframe/protocol';
import { computeCrashFingerprint } from '@everframe/sdk-core';

const BUNDLE_FRAME = /([0-9a-f]{64})\.bundle:\d+:\d+/;
// Only an absolute or file:// directory is stripped. `address at …` frames
// (bytecode offsets, no debug info) are left exactly as Hermes wrote them.
const DIR = String.raw`(?:\/[^()\n]*\/|file:\/\/[^()\n]*\/)`;
const ID_POSITION = String.raw`([0-9a-f]{64}\.bundle:\d+:\d+)`;
const IN_PARENS = new RegExp(String.raw`\(${DIR}${ID_POSITION}\)`, 'g');
const BARE = new RegExp(String.raw`^at ${DIR}${ID_POSITION}$`);
const ANY_BUNDLE_ID = /[0-9a-f]{64}\.bundle/g;
const MAX_PROBE = 64 * 1024;

/** The 64-hex bundle id named by a stack from this bundle, if any. */
export function probeBundleId(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined;
  return BUNDLE_FRAME.exec(stack.slice(0, MAX_PROBE))?.[1];
}

export function jsBundleFor(bundleId: string): JsBundleMetadata {
  return { engine: 'hermes', platform: 'vega', buildId: bundleId, bundleName: `${bundleId}.bundle` };
}

/**
 * Drops the build machine's directory in front of `<id>.bundle:L:C`. The
 * server matches frames by bundle name, and the directory is the developer's
 * local path.
 */
export function stripBuildPath(raw: string): string {
  return raw.replace(IN_PARENS, '($1)').replace(BARE, 'at $1');
}

/**
 * sdk-core's grouping rule over frames whose bundle id is replaced by a
 * constant, so one error in two builds groups together. Digits are already
 * ignored by the rule; the id's hex letters are not.
 */
export function vegaFingerprint(exceptionType: string, frames: ReadonlyArray<{ raw: string }>): string {
  return computeCrashFingerprint(
    exceptionType,
    frames.map((frame) => ({ raw: frame.raw.replace(ANY_BUNDLE_ID, 'app.bundle') })),
  );
}

/** Admission key: exception type and the normalized top frame. */
export function captureKey(exceptionType: string, frames: ReadonlyArray<string>): string {
  return `${exceptionType}:${(frames[0] ?? '').replace(ANY_BUNDLE_ID, 'app.bundle').replace(/\d+/g, '#')}`;
}
