// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment node */
// esbuild refuses to run under jsdom (its TextEncoder is not the realm's
// Uint8Array), so this spec builds in the node environment.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { build } from 'esbuild';
import { UI_SHARED_MODULES, uiSharedModulesPlugin } from '../../scripts/ui-shared-modules.js';

const PKG = path.resolve(__dirname, '..', '..');

// The `/ui` build as tsup.config.ts's reactEntry runs it, minus minify, so the
// import statement stays readable.
async function buildUi() {
  const result = await build({
    entryPoints: [path.join(PKG, 'src/ui.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    metafile: true,
    logLevel: 'silent',
    define: { __EVERFRAME_INGEST_URL__: '""' },
    external: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'lucide-react',
      'react-konva',
      'konva',
      'zod',
    ],
    plugins: [uiSharedModulesPlugin],
  });
  return { code: result.outputFiles[0]!.text, inputs: Object.keys(result.metafile.inputs) };
}

describe('dist/ui.js shares stateful modules with dist/index.js', () => {
  it('inlines none of the shared modules', async () => {
    const { inputs } = await buildUi();
    for (const mod of UI_SHARED_MODULES) {
      expect(inputs.some((f) => f.endsWith(`src/${mod}.ts`)), mod).toBe(false);
    }
  });

  it('imports every name it needs from ./index.js, and the index exports each one', async () => {
    const { code } = await buildUi();
    const names = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/index\.js["']/g)]
      .flatMap((m) => m[1]!.split(','))
      .map((s) => s.trim().split(/\s+as\s+/)[0]!)
      .filter(Boolean);

    // Theme, watermark, badge and PIN card all read through the shared entry.
    expect(names).toEqual(
      expect.arrayContaining([
        '__getBrandingServerConfig',
        '__subscribeBrandingServerConfig',
        '__getInlineReporterTheme',
        '__subscribeInlineReporterTheme',
        '__getCompanionApi',
        '__getCompanionBadgeConfig',
        '__getAttachPinUiMode',
        '__getCompanionBadgeServerConfig',
        '__subscribeCompanionBadgeServerConfig',
      ]),
    );

    // esbuild does not check names imported from an external module: a name
    // missing from the index would be `undefined` at runtime, not a build error.
    const index = (await import('../../src/index.js')) as Record<string, unknown>;
    for (const name of names) expect(index[name], name).toBeTypeOf('function');
  });
});
