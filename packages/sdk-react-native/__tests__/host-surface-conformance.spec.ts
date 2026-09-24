// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, it } from 'vitest';
import { assertHostSurface } from '@everframe/sdk-core/conformance';
import * as rnSdk from '../src/index.js';

describe('@everframe/react-native host surface', () => {
  it('satisfies the shared contract', () => {
    assertHostSurface(rnSdk as unknown as Record<string, unknown>, '@everframe/react-native');
  });
});
