// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createReadStream } from 'node:fs';

export interface BundleIdentity { buildId: string; platform: 'android' | 'ios'; bundleName: string }
const IDENTITY_SOURCE = /(?:^|\/)\.everframe\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/identity\.js$/i;
/** Read generated metadata; never execute source-map contents. */
export function readBundleIdentity(input: unknown, platform: 'android' | 'ios'): BundleIdentity {
  const map = input as { version?: unknown; sources?: unknown; sourcesContent?: unknown } | null;
  if (!map || map.version !== 3 || !Array.isArray(map.sources) ||
      (map.sourcesContent !== undefined && (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length)))
    throw new Error('invalid_bundle_identity');
  const identities: BundleIdentity[] = [];
  for (let index = 0; index < map.sources.length; index++) {
    const source = map.sources[index];
    const match = typeof source === 'string' ? IDENTITY_SOURCE.exec(source.replaceAll('\\', '/')) : null;
    if (!match) continue;
    const identity: BundleIdentity = { buildId: match[1]!, platform, bundleName: platform === 'android' ? 'index.android.bundle' : 'main.jsbundle' };
    const content = (map.sourcesContent as unknown[] | undefined)?.[index];
    // Source contents may be omitted for privacy; the generated source path still
    // identifies the partial, and collection checks the compiled ID separately.
    if (content !== undefined && content !== null) {
      const assignment = typeof content === 'string'
        ? /^globalThis\.__EVERFRAME_BUILD__ = Object\.freeze\((\{[^\r\n]*\})\);(?:\r?\n)?$/.exec(content)
        : null;
      if (!assignment) throw new Error('invalid_bundle_identity');
      let value: unknown;
      try { value = JSON.parse(assignment[1]!); } catch { throw new Error('invalid_bundle_identity'); }
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 ||
          (value as BundleIdentity).buildId !== identity.buildId ||
          (value as BundleIdentity).platform !== identity.platform ||
          (value as BundleIdentity).bundleName !== identity.bundleName)
        throw new Error('invalid_bundle_identity');
    }
    identities.push(identity);
  }
  if (identities.length !== 1) throw new Error(identities.length ? 'ambiguous_bundle_identity' : 'missing_bundle_identity');
  return identities[0]!;
}
/** Accidentally mixed build inputs must fail; this is not a cryptographic map proof. */
export async function assertCompiledBuildIdentity(bundlePath: string, buildId: string): Promise<void> {
  const needle = Buffer.from(buildId, 'utf8');
  let tail = Buffer.alloc(0);
  try {
    for await (const chunk of createReadStream(bundlePath)) {
      const bytes = Buffer.concat([tail, chunk as Buffer]);
      if (bytes.includes(needle)) return;
      tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - needle.length + 1)));
    }
  } catch { throw new Error('bundle_not_found'); }
  throw new Error('compiled_build_identity_missing');
}
