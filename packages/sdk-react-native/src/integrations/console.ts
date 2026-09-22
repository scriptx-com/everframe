// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Opt-in JS console capture (spec 2026-07-14 RN-iOS parity). JS logs never
// reliably reach native stderr (especially release builds), so the native
// stderr tee misses them entirely — and flattens what it does see to
// level info. This hook forwards console output to the native breadcrumb
// buffer with REAL severity. The native tee stays installed underneath;
// debug-build double-capture is acceptable and documented.
//
// Contract: original console method ALWAYS runs first; nothing in the crumb
// path may throw into host logging; the inHook guard makes a crumb sink
// that itself logs (the Android stderr-tee recursion of 2026-07-14) a
// non-event; '[traceitx]'-prefixed lines are skipped so SDK noise never
// self-crumbs.
import { addBreadcrumb } from '../contextSeam.js';
import type { TraceItXIntegration } from './types.js';

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

// BreadcrumbLevel vocabulary is debug/error/info/warn (protocol
// Generated.swift) — 'log' maps to info; invalid levels would be DROPPED by
// native coercion, so only these four ever cross the bridge.
const NATIVE_LEVEL: Record<ConsoleLevel, string> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

// Pre-bridge cap; the native ring buffer caps again at 2048 UTF-16 units —
// this just keeps oversized payloads off the bridge.
const MAX_MESSAGE = 2048;

export function consoleIntegration(opts?: { levels?: ConsoleLevel[] }): TraceItXIntegration {
  const levels = [...new Set<ConsoleLevel>(opts?.levels ?? ['log', 'info', 'warn', 'error'])];
  return {
    name: 'console',
    setup() {
      let inHook = false;
      const originals: Array<{ level: ConsoleLevel; fn: (...args: unknown[]) => void }> = [];
      for (const level of levels) {
        const fn = console[level] as ((...args: unknown[]) => void) | undefined;
        if (typeof fn !== 'function') continue;
        originals.push({ level, fn });
        const original = fn.bind(console);
        console[level] = (...args: unknown[]) => {
          original(...args);          // host behavior first, always
          if (inHook) return;         // re-entrancy: a logging crumb sink must not loop
          inHook = true;
          try {
            const message = serializeArgs(args);
            if (message && !message.startsWith('[traceitx]')) {
              addBreadcrumb({ message, kind: 'console', level: NATIVE_LEVEL[level] });
            }
          } catch {
            // Never throw into host logging.
          } finally {
            inHook = false;
          }
        };
      }
      return () => {
        for (const { level, fn } of originals) console[level] = fn;
      };
    },
  };
}

function serializeArgs(args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try {
      return JSON.stringify(a) ?? String(a);
    } catch {
      return String(a); // circular structures etc.
    }
  });
  const joined = parts.join(' ');
  return joined.length > MAX_MESSAGE ? joined.slice(0, MAX_MESSAGE) : joined;
}
