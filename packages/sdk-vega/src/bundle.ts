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

// A top frame that names no function: Hermes' `at anonymous (…)` and
// `at global (…)`, or a bare `at <file>:L:C`. Timer and promise callbacks
// often produce exactly one such frame, so with digits ignored every error
// thrown straight in an arrow function would share one identity.
const NAMELESS_TOP = /^at (?:(?:anonymous|global|<anonymous>) \(|[^\s()]+:\d+:\d+$)/;
const MAX_KEY_MESSAGE = 200;

function namelessTop(frames: ReadonlyArray<string>): boolean {
  const top = frames[0];
  return top === undefined || NAMELESS_TOP.test(top);
}

function keyMessage(message: string): string {
  return message.slice(0, MAX_KEY_MESSAGE);
}

/**
 * sdk-core's grouping rule over frames whose bundle id is replaced by a
 * constant, so one error in two builds groups together. Digits are already
 * ignored by the rule; the id's hex letters are not. When the top frame names
 * no function, the message (digits ignored too) joins the key, so two
 * different errors from two arrow functions do not merge.
 */
export function vegaFingerprint(
  exceptionType: string,
  frames: ReadonlyArray<{ raw: string }>,
  message: string,
): string {
  const normalized = frames.map((frame) => ({ raw: frame.raw.replace(ANY_BUNDLE_ID, 'app.bundle') }));
  const keyed = namelessTop(normalized.map((frame) => frame.raw))
    ? [{ raw: `message: ${keyMessage(message)}` }, ...normalized]
    : normalized;
  return computeCrashFingerprint(exceptionType, keyed);
}

/** Per-launch admission key: exception type, normalized top frame, and the message under the same rule. */
export function captureKey(exceptionType: string, frames: ReadonlyArray<string>, message: string): string {
  const top = (frames[0] ?? '').replace(ANY_BUNDLE_ID, 'app.bundle').replace(/\d+/g, '#');
  return namelessTop(frames)
    ? `${exceptionType}:${top}:${keyMessage(message).replace(/\d+/g, '#')}`
    : `${exceptionType}:${top}`;
}
