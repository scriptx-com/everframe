// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stagingRoot } from '../src/staging.js';
import { withEverframe } from '../src/index.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'everframe-wrap-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Every file under the staging root, recursively, as paths relative to it. */
function filesUnderStagingRoot(projectRoot: string): string[] {
  const base = stagingRoot(projectRoot);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(base);
  return out.sort();
}

describe('withEverframe', () => {
  it('stages identity for both platforms synchronously at call time, before getPolyfills is ever called', () => {
    // This is the regression test for the "Failed to get the SHA-1"
    // defect: Metro crawls the file map before bundling starts and only
    // calls `getPolyfills` afterwards, so a file that doesn't exist until
    // `getPolyfills` runs is invisible to that crawl. Both platforms'
    // identity files must already be on disk the moment `withEverframe`
    // returns — with getPolyfills never invoked here.
    withEverframe({}, { projectRoot: root, enabled: true });
    const androidPointer = JSON.parse(
      readFileSync(join(stagingRoot(root), 'latest-android.json'), 'utf8'),
    ) as { buildId: string };
    const iosPointer = JSON.parse(
      readFileSync(join(stagingRoot(root), 'latest-ios.json'), 'utf8'),
    ) as { buildId: string };
    const androidIdentity = join(stagingRoot(root), androidPointer.buildId, 'identity.js');
    const iosIdentity = join(stagingRoot(root), iosPointer.buildId, 'identity.js');
    expect(existsSync(androidIdentity)).toBe(true);
    expect(existsSync(iosIdentity)).toBe(true);
    expect(readFileSync(androidIdentity, 'utf8')).toContain('"platform":"android"');
    expect(readFileSync(iosIdentity, 'utf8')).toContain('"platform":"ios"');
  });

  it('getPolyfills performs no writes: the staged file set is unchanged before and after calling it', () => {
    const config = withEverframe({}, { projectRoot: root, enabled: true });
    const before = filesUnderStagingRoot(root);
    expect(before.length).toBeGreaterThan(0);
    config.serializer.getPolyfills({ platform: 'android' });
    config.serializer.getPolyfills({ platform: 'ios' });
    config.serializer.getPolyfills({ platform: 'android' });
    const after = filesUnderStagingRoot(root);
    expect(after).toEqual(before);
  });

  it('returns a plain array synchronously, never a Promise', () => {
    // This is the regression test: Metro consumes getPolyfills
    // synchronously (`.getPolyfills({...}).concat(...)` with no await), so
    // a Promise here breaks every bundle with "polyfills is not iterable".
    const config = withEverframe({}, { projectRoot: root, enabled: true });
    const result = config.serializer.getPolyfills({ platform: 'android' });
    expect(result instanceof Promise).toBe(false);
    expect(Array.isArray(result)).toBe(true);
  });

  it('appends the identity polyfill to an existing getPolyfills', () => {
    const config = withEverframe(
      { serializer: { getPolyfills: () => ['/existing/polyfill.js'] } },
      { projectRoot: root, enabled: true },
    );
    const polyfills = config.serializer.getPolyfills({ platform: 'android' });
    expect(Array.isArray(polyfills)).toBe(true);
    expect(polyfills).toHaveLength(2);
    const [existing, identity] = polyfills;
    expect(existing).toBe('/existing/polyfill.js');
    expect(identity).toBeDefined();
    expect(readFileSync(identity as string, 'utf8')).toContain('__EVERFRAME_BUILD__');
  });

  it('works when the config has no serializer at all', () => {
    const config = withEverframe({}, { projectRoot: root, enabled: true });
    const polyfills = config.serializer.getPolyfills({ platform: 'ios' });
    expect(Array.isArray(polyfills)).toBe(true);
    expect(polyfills).toHaveLength(1);
  });

  it('returns a stable id for repeated calls on the same platform', () => {
    const config = withEverframe({}, { projectRoot: root, enabled: true });
    const first = config.serializer.getPolyfills({ platform: 'android' });
    const second = config.serializer.getPolyfills({ platform: 'android' });
    expect(first[0]).toBe(second[0]);
  });

  it('gives different platforms different ids', () => {
    const config = withEverframe({}, { projectRoot: root, enabled: true });
    const android = config.serializer.getPolyfills({ platform: 'android' });
    const ios = config.serializer.getPolyfills({ platform: 'ios' });
    expect(android[0]).not.toBe(ios[0]);
  });

  it('is a no-op when disabled, staging nothing', async () => {
    const original = { serializer: { getPolyfills: () => ['/existing/polyfill.js'] } };
    const config = withEverframe(original, { projectRoot: root, enabled: false });
    expect(config).toBe(original);
    await expect(readFile(join(stagingRoot(root), 'latest-android.json'), 'utf8')).rejects.toThrow();
  });

  it('ignores platforms that are not android or ios', () => {
    const config = withEverframe({}, { projectRoot: root, enabled: true });
    const result = config.serializer.getPolyfills({ platform: 'web' });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });
});
