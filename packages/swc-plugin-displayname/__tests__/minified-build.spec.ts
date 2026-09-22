// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(__dirname, '..', 'swc_plugin_displayname.wasm');
const fixturePath = path.resolve(__dirname, 'fixtures', 'components.tsx');
const wasmAvailable = existsSync(wasmPath);

describe.skipIf(!wasmAvailable)('PAY-06 success criterion #3: SWC + terser preserves displayName', () => {
  let swc: typeof import('@swc/core');

  beforeAll(async () => {
    swc = await import('@swc/core');
  });

  async function buildMinified(): Promise<string> {
    const src = readFileSync(fixturePath, 'utf8');
    const transformed = await swc.transform(src, {
      filename: 'components.tsx',
      jsc: {
        parser: { syntax: 'typescript', tsx: true },
        target: 'es2022',
        experimental: { plugins: [[wasmPath, {}]] },
      },
      module: { type: 'es6' },
    });
    const min = await minify(transformed.code, {
      mangle: { toplevel: true },
      compress: true,
      format: { ascii_only: true },
    });
    return min.code ?? '';
  }

  it.each(['Foo', 'Bar', 'Baz', 'Comp'])(
    '%s displayName preserved through minification',
    async (name) => {
      const minified = await buildMinified();
      expect(minified).toMatch(new RegExp(`displayName\\s*[:=]\\s*["']${name}["']`));
    }
  );
});
