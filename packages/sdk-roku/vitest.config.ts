// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig, mergeConfig } from 'vitest/config';
import { baseConfig } from '../../vitest.base.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: 'sdk-roku',
      include: ['__tests__/**/*.spec.ts'],
      // brs-cli boots a full interpreter per call (~1s).
      testTimeout: 60000,
    },
  }),
);
