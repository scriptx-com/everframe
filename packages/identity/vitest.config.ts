// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.js'; // NAMED import — default resolves undefined

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['__tests__/**/*.spec.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  }),
);
