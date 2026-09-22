// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Bundle exactly the imports used by SDK builds: unused SHA-512 BigInt code
// must be tree-shaken before evaluating in a legacy browser.
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';

async function bundle(source: string) {
  const result = await build({ stdin: { contents: source, resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'sut', write: false, platform: 'browser' });
  return result.outputFiles[0]!.text;
}

describe('legacy runtime dependencies', () => {
  it('hashes screenshot/report bytes correctly without BigInt', async () => {
    const source = await bundle('export { sha256 } from "@noble/hashes/sha2";');
    const context = { BigInt: undefined, Uint8Array, Uint32Array, DataView, TextEncoder };
    const hash = runInNewContext(source + '; sut.sha256', context) as (bytes: Uint8Array) => Uint8Array;
    for (const size of [0, 3, 55, 56, 63, 64, 65, 1000, 153942]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
      expect(Buffer.from(hash(bytes)).toString('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('validates object schemas when eval exists but object spread is unsupported', async () => {
    const source = await bundle('import { z } from "zod"; export const schema = z.object({ enabled: z.boolean(), count: z.number() });');
    const LegacyFunction = function (...args: string[]) {
      if (args.some(arg => /\.\.\./.test(arg))) throw new SyntaxError('Object spread unsupported');
      return Function(...args);
    };
    const schema = runInNewContext(source + '; sut.schema', { Function: LegacyFunction }) as { safeParse: (value: unknown) => { success: boolean } };
    expect(schema.safeParse({ enabled: true, count: 3 }).success).toBe(true);
    expect(schema.safeParse({ enabled: 'true', count: 3 }).success).toBe(false);
  });

  it('preserves the high length word and both byte orders above 512 MiB', async () => {
    const source = await bundle(`
      import { HashMD } from '@noble/hashes/_md';
      export function padding(isLE) {
        class Probe extends HashMD {
          constructor() { super(64, 32, 8, isLE); this.length = 0x20000001; }
          process(view) { this.tail = Array.from(new Uint8Array(view.buffer).slice(-8)); }
          get() { return [0,0,0,0,0,0,0,0]; }
        }
        const probe = new Probe();
        probe.digestInto(new Uint8Array(32));
        return probe.tail;
      }
    `);
    const padding = runInNewContext(source + '; sut.padding', { BigInt: undefined, Uint8Array, Uint32Array, DataView }) as (isLE: boolean) => number[];
    expect(padding(false)).toEqual([0, 0, 0, 1, 0, 0, 0, 8]);
    expect(padding(true)).toEqual([8, 0, 0, 0, 1, 0, 0, 0]);
  });
});
