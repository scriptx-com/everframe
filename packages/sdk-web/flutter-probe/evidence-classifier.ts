// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export interface StockEvidenceInput {
  width: number;
  height: number;
  publicColorFraction: number;
  sensitiveMagentaFraction: number;
  sensitiveBlackFraction: number;
  canvasFrameHashes: string[];
  apiOrigins: string[];
}

export interface StockEvidenceResult {
  screenshotVisible: boolean;
  maskSafe: boolean;
  visualReplay: boolean;
  reasons: string[];
}

export function classifyStockEvidence(input: StockEvidenceInput): StockEvidenceResult {
  const screenshotVisible = input.width >= 640
    && input.height >= 360
    && input.publicColorFraction >= 0.8;
  const maskSafe = screenshotVisible
    && input.sensitiveBlackFraction >= 0.95
    && input.sensitiveMagentaFraction <= 0.01;
  const visualReplay = new Set(input.canvasFrameHashes).size >= 2;
  const reasons: string[] = [];

  if (!screenshotVisible) reasons.push('screenshot lacks a readable public tile');
  if (!maskSafe) reasons.push('sensitive tile is not safely masked');
  if (!visualReplay) reasons.push('replay lacks two distinct canvas frames');
  for (const origin of input.apiOrigins) {
    if (origin !== 'http://127.0.0.1:8937') {
      reasons.push(`non-local Everframe API origin: ${origin}`);
    }
  }

  return { screenshotVisible, maskSafe, visualReplay, reasons };
}
