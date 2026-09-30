// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: 'example-roku',
      include: ['__tests__/**/*.spec.ts'],
      testTimeout: 300000,
    },
  }),
);
