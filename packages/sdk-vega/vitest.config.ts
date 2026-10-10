// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default mergeConfig(
  baseConfig,
  defineConfig({
    define: { __EVERFRAME_VEGA_VERSION__: JSON.stringify(version) },
    test: {
      environment: 'node',
      include: ['__tests__/**/*.spec.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
    resolve: {
      // `react-native` is a peer and is not installed in this workspace; the
      // stub answers the three reads device.ts makes.
      alias: {
        'react-native': fileURLToPath(new URL('./__tests__/stubs/react-native.ts', import.meta.url)),
      },
    },
  }),
);
