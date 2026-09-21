// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { transformAsync } from '@babel/core';
import { minify } from 'terser';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../../../src/index.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildMinified() {
  const src = readFileSync(path.join(__dirname, 'src', 'components.tsx'), 'utf8');
  const transformed = await transformAsync(src, {
    babelrc: false,
    configFile: false,
    presets: [['@babel/preset-typescript', { allExtensions: true, isTSX: true }], '@babel/preset-react'],
    plugins: [plugin],
    filename: 'components.tsx',
  });
  const code = transformed?.code ?? '';
  const min = await minify(code, {
    mangle: { toplevel: true },
    compress: true,
    format: { ascii_only: true },
  });
  return { transformed: code, minified: min.code ?? '' };
}
