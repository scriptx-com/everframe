// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment node */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('legacy browser compatibility', () => {
  it('loads Zod when the engine has no BigInt global', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `globalThis.BigInt = undefined;
         await import('zod');`,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );

    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
  });
});
