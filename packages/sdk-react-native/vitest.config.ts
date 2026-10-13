// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
// NAMED import per Phase 02-01 lock — vitest.base.ts exports a named const,
// default would resolve to undefined and break mergeConfig().
import { baseConfig } from '../../vitest.base.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      setupFiles: ['./vitest.setup.ts'],
    },
    resolve: {
      // `react-native` is a peerDependency, not installed in this workspace.
      // Route imports to a tiny stub so vi.mock has a resolvable target.
      // See __tests__/stubs/react-native.ts for the rationale.
      alias: {
        // Most specific first — see packages/sdk-react/vitest.config.ts for
        // why: @rollup/plugin-alias matches in insertion order, and a bare
        // '@everframe/sdk-core' key (added by a future change) would also
        // match this subpath and swallow it.
        '@everframe/sdk-core/conformance': fileURLToPath(
          new URL('../sdk-core/src/conformance/host-surface.ts', import.meta.url),
        ),
        // Before the bare 'react-native' key, which would also match this subpath.
        'react-native/Libraries/Core/ExceptionsManager': new URL(
          './__tests__/stubs/react-native-exceptions-manager.ts',
          import.meta.url,
        ).pathname,
        'react-native': new URL('./__tests__/stubs/react-native.ts', import.meta.url).pathname,
      },
    },
  }),
);
