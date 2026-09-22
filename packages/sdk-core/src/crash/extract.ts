// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { CrashFrame } from '@traceitx/protocol';

/** Protocol caps (see @traceitx/protocol ReportEnvelope crash payload schema). */
export const MAX_MESSAGE = 4096;
const MAX_FRAMES = 256;
export const MAX_RAW = 1024;
const MAX_TYPE = 256;

export interface CrashFacts {
  exceptionType: string;
  message: string;
  frames: CrashFrame[];
}

/**
 * Normalize any thrown/rejected value into protocol-capped crash facts.
 * Frames are raw stack lines only — no parsing beyond dropping the V8-style
 * "Name: message" header line (Firefox/Safari stacks have no header).
 * RN's src/errors.ts (deliberately NOT under integrations/ — see its header)
 * intentionally inlines this same logic (sdk-core is type-only there) —
 * keep the two in sync.
 */
export function extractCrashFacts(err: unknown): CrashFacts {
  if (err instanceof Error) {
    const exceptionType = (err.name || 'Error').slice(0, MAX_TYPE);
    const message = String(err.message ?? '').slice(0, MAX_MESSAGE);
    const stack = typeof err.stack === 'string' ? err.stack : '';
    let lines = stack.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const first = lines[0];
    if (first !== undefined && (first === exceptionType || first.startsWith(`${exceptionType}:`))) {
      lines = lines.slice(1);
    }
    return {
      exceptionType,
      message,
      frames: lines.slice(0, MAX_FRAMES).map((raw) => ({ raw: raw.slice(0, MAX_RAW) })),
    };
  }
  let rendered: string;
  try {
    rendered = typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err);
  } catch {
    rendered = String(err);
  }
  return { exceptionType: 'UnhandledValue', message: rendered.slice(0, MAX_MESSAGE), frames: [] };
}
