// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(__dirname, '..', 'swc_plugin_displayname.wasm');
const fixturePath = path.resolve(__dirname, 'fixtures', 'components.tsx');

const wasmAvailable = existsSync(wasmPath);

describe.skipIf(!wasmAvailable)('PAY-06: SWC plugin cases (parity with displayname-cases.md)', () => {
  let swc: typeof import('@swc/core');

  beforeAll(async () => {
    swc = await import('@swc/core');
  });

  async function transform(code: string): Promise<string> {
    const result = await swc.transform(code, {
      filename: 'components.tsx',
      jsc: {
        parser: { syntax: 'typescript', tsx: true },
        target: 'es2022',
        experimental: {
          plugins: [[wasmPath, {}]],
        },
      },
      module: { type: 'es6' },
    });
    return result.code;
  }

  it('forwardref: const Foo = forwardRef(...) → Foo.displayName = "Foo"', async () => {
    const code = `import { forwardRef } from 'react'; const Foo = forwardRef((p, r) => null); export default Foo;`;
    const out = await transform(code);
    expect(out).toMatch(/Foo\.displayName\s*=\s*["']Foo["']/);
  });

  it('memo: const Bar = memo(...)', async () => {
    const code = `import { memo } from 'react'; const Bar = memo(() => null); export default Bar;`;
    const out = await transform(code);
    expect(out).toMatch(/Bar\.displayName\s*=\s*["']Bar["']/);
  });

  it('forwardref-memo: nested factory', async () => {
    const code = `import { memo, forwardRef } from 'react'; const Baz = memo(forwardRef((p, r) => null)); export default Baz;`;
    const out = await transform(code);
    expect(out).toMatch(/Baz\.displayName\s*=\s*["']Baz["']/);
  });

  it('function-decl: uppercase function adds displayName, lowercase does not', async () => {
    const code = readFileSync(fixturePath, 'utf8');
    const out = await transform(code);
    expect(out).toMatch(/Comp\.displayName\s*=\s*["']Comp["']/);
    expect(out).not.toMatch(/helper\.displayName/);
  });
});

describe.skipIf(wasmAvailable)('SWC plugin tests skipped (WASM not built)', () => {
  it('reminds developer to run `node build-wasm.mjs`', () => {
    console.warn('[swc-plugin-test] swc_plugin_displayname.wasm not found at', wasmPath);
    console.warn('Run: node packages/swc-plugin-displayname/build-wasm.mjs');
    console.warn('(Tests skip gracefully when WASM artifact is absent.)');
    expect(wasmAvailable).toBe(false); // Document the skip in test output
  });
});
