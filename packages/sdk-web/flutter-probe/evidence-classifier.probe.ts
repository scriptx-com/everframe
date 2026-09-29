// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, test } from '@playwright/test';
import { classifyStockEvidence } from './evidence-classifier.js';

const base = () => ({
  width: 1280,
  height: 720,
  publicColorFraction: 0.9,
  sensitiveMagentaFraction: 0,
  sensitiveBlackFraction: 1,
  canvasFrameHashes: ['frame-a', 'frame-b'],
  apiOrigins: ['http://127.0.0.1:8938'],
});

test('rejects a 1×1 fallback even if its mask pixels are black', () => {
  const result = classifyStockEvidence({ ...base(), width: 1, height: 1 });
  expect(result.screenshotVisible).toBe(false);
  expect(result.maskSafe).toBe(false);
});

test('rejects visible magenta in the sensitive region', () => {
  const result = classifyStockEvidence({
    ...base(),
    sensitiveMagentaFraction: 0.9,
    sensitiveBlackFraction: 0.1,
  });
  expect(result.maskSafe).toBe(false);
});

test('does not treat an attachment with no canvas frames as visual replay', () => {
  const result = classifyStockEvidence({ ...base(), canvasFrameHashes: [] });
  expect(result.visualReplay).toBe(false);
});

test('requires two distinct canvas frames for visual replay', () => {
  const same = classifyStockEvidence({ ...base(), canvasFrameHashes: ['frame-a', 'frame-a'] });
  const changed = classifyStockEvidence(base());
  expect(same.visualReplay).toBe(false);
  expect(changed.visualReplay).toBe(true);
});

test('flags any Everframe API origin outside loopback', () => {
  const result = classifyStockEvidence({
    ...base(),
    apiOrigins: ['http://127.0.0.1:8938', 'https://everframe.dev'],
  });
  expect(result.reasons).toContain('non-local Everframe API origin: https://everframe.dev');
});
