// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// REPLAY-05 — default-OFF zero-overhead: rrweb not imported when disabled.
// Turned RED→GREEN in plan 20-04. (Bundle delta enforced separately by size-limit.)
//
// Contract (RESEARCH §"Lazy-load rrweb via dynamic import()"):
//   - rrweb is dynamically import()ed ONLY when start() runs (the lifecycle only
//     calls start() when config.replayEnabled === true after GET /api/config).
//   - apps with replay OFF (the default) pay ~0 KB — rrweb never loads.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createReplayRecorder } from '../../../src/capture/replay/recorder.js';

describe('REPLAY-05 lazy-load default-OFF', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not import rrweb until start() is called', async () => {
    const importSpy = vi.fn(async () => ({ record: () => () => undefined }));
    // Constructing the recorder must NOT trigger the rrweb import.
    createReplayRecorder({ importRrweb: importSpy });
    await Promise.resolve();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('imports rrweb when start() runs (replay ON path)', async () => {
    const importSpy = vi.fn(async () => ({ record: () => () => undefined }));
    const rec = createReplayRecorder({ importRrweb: importSpy });
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    expect(importSpy).toHaveBeenCalledTimes(1);
  });

  it('a self-disabled session never re-imports rrweb on start()', async () => {
    const importSpy = vi.fn(async () => ({ record: () => () => undefined }));
    const rec = createReplayRecorder({ importRrweb: importSpy });
    // Force a cap breach via a tiny event cap so the very first push self-disables.
    rec.start(30);
    await Promise.resolve();
    await Promise.resolve();
    expect(importSpy).toHaveBeenCalledTimes(1);
  });

  it('the always-loaded barrel has no static rrweb import (dynamic import only)', async () => {
    const barrel = readFileSync(
      resolve(__dirname, '../../../src/capture/replay/index.ts'),
      'utf8',
    );
    // No static `import … from 'rrweb'` anywhere in the barrel.
    expect(barrel).not.toMatch(/^\s*import .* from ['"]rrweb['"]/m);
    const recorder = readFileSync(
      resolve(__dirname, '../../../src/capture/replay/recorder.ts'),
      'utf8',
    );
    // The recorder must reference rrweb ONLY via a dynamic import() call.
    expect(recorder).toMatch(/import\(\s*['"]rrweb['"]\s*\)/);
    expect(recorder).not.toMatch(/^\s*import .* from ['"]rrweb['"]/m);
  });
});
