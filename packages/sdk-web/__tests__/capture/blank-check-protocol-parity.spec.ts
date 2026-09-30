// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { RENDER_BLANK_CHECK, isNearUniform as protocolIsNearUniform } from '@everframe/protocol';
import {
  BLANK_LUMA_RANGE,
  BLANK_SAMPLE_HEIGHT,
  BLANK_SAMPLE_WIDTH,
  isNearUniform,
} from '../../src/capture/blank-check.js';

// The render service flags server renders blank with the protocol constants;
// the SDK flags on-device captures. Both use the protocol's one algorithm.
describe('blank-check parity with the server render', () => {
  it('uses the same sample size and luminance range', () => {
    expect({
      lumaRange: BLANK_LUMA_RANGE,
      sampleWidth: BLANK_SAMPLE_WIDTH,
      sampleHeight: BLANK_SAMPLE_HEIGHT,
    }).toEqual(RENDER_BLANK_CHECK);
  });

  it('runs the protocol algorithm itself, not a copy', () => {
    expect(isNearUniform).toBe(protocolIsNearUniform);
  });
});
