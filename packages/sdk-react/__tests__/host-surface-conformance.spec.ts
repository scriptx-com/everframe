// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { describe, it } from 'vitest';
import { assertHostSurface } from '@traceitx/sdk-core/conformance';
import * as reactSdk from '../src/index.js';

describe('@traceitx/react host surface', () => {
  it('satisfies the shared contract', () => {
    assertHostSurface(reactSdk as unknown as Record<string, unknown>, '@traceitx/react');
  });
});
