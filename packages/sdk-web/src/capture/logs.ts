// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type { LogEntry } from '@traceitx/sdk-core';
import { pushLogEntry } from './buffers.js';
import type { CrumbSink, KindGate, CrashSink } from './breadcrumbs.js';

const PATCH_MARKER = Symbol.for('__traceitx_patched_console__');
const ALL_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type Level = (typeof ALL_LEVELS)[number];

/** console level → breadcrumb level (breadcrumbs have no 'log'). */
const CRUMB_LEVEL: Record<Level, 'debug' | 'info' | 'warn' | 'error'> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

export interface ConsolePatcherOptions {
  levels?: Level[];
  /** Optional breadcrumb dual-write (spec §5): console→console crumbs, uncaught→error crumbs. */
  crumbSink?: CrumbSink;
  crumbGate?: KindGate;
  /** Crash/error reporting hook (spec 2026-07-18): called AFTER the error
   *  breadcrumb for every uncaught error / unhandled rejection. Pass the
   *  stable forwardingCrashSink (breadcrumbs.ts), never an adapter's own sink
   *  — this patcher is install-once, so a directly-captured sink would outlive
   *  its adapter across Provider remounts. */
  crashSink?: CrashSink;
}

/**
 * Render console args into a single message string, then we drop `args`.
 *
 * Console's first arg can be a format string with %s/%d/%i/%f/%o/%O/%j/%c/%%
 * placeholders consumed positionally from the rest of the args; any args left
 * over are appended space-separated (matching browser console + util.format).
 * This keeps the substituted values (often the useful part — e.g. the prop
 * name in a React warning) instead of shipping a raw `%s` template plus a
 * duplicate `args` array.
 */
function formatConsoleArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  const first = args[0];
  const rest = args.slice(1);

  let out: string;
  if (typeof first === 'string' && /%[sdifoOjc%]/.test(first)) {
    let ai = 0;
    out = first.replace(/%([sdifoOjc%])/g, (whole, spec: string) => {
      if (spec === '%') return '%';
      if (ai >= rest.length) return whole; // no arg left — leave the token as-is
      const arg = rest[ai++];
      switch (spec) {
        case 's':
          return typeof arg === 'string' ? arg : stringify(arg);
        case 'd':
        case 'i': {
          const n = Number(arg);
          return Number.isNaN(n) ? 'NaN' : String(Math.trunc(n));
        }
        case 'f': {
          const n = Number(arg);
          return Number.isNaN(n) ? 'NaN' : String(n);
        }
        case 'c':
          return ''; // CSS styling directive — consumes the arg, renders nothing
        default: // o, O, j → object
          return stringify(arg);
      }
    });
    const leftover = rest.slice(ai);
    if (leftover.length) out += ' ' + leftover.map(stringify).join(' ');
  } else {
    out = args.map(stringify).join(' ');
  }
  return out;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  try {
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  } catch {
    return String(v); // circular / non-serializable
  }
}

function pushEntry(level: LogEntry['level'], args: unknown[]): void {
  // Store only the rendered message — no `args` (it duplicated message and
  // ballooned the envelope; the substituted values are now folded into message).
  pushLogEntry({ level, message: formatConsoleArgs(args), timestamp: Date.now() });
}

/**
 * installConsolePatcher — Patches console.{log,info,warn,error,debug} +
 * window.onerror + unhandledrejection so the rolling buffer reflects activity from
 * before the reporter was opened.
 *
 * Idempotent: a second install no-ops via `Symbol.for('__traceitx_patched_console__')`.
 *
 * Sentry coexistence: chains to whatever console wrapper was installed before us, so
 * Sentry breadcrumbs / Bugsnag breadcrumbs continue to receive every call.
 *
 * Returns an uninstall fn that restores originals captured at install time and clears
 * the symbol marker so a subsequent install re-applies cleanly.
 */
export function installConsolePatcher(opts: ConsolePatcherOptions = {}): () => void {
  if (typeof globalThis === 'undefined' || typeof console === 'undefined') {
    return () => undefined; // SSR / non-browser
  }
  const slot = globalThis as unknown as Record<symbol, unknown>;
  if (slot[PATCH_MARKER]) return () => undefined;
  slot[PATCH_MARKER] = true;

  const levels = opts.levels ?? [...ALL_LEVELS];
  const crumb = (input: Parameters<CrumbSink>[0]): void => {
    try {
      if (opts.crumbSink && (opts.crumbGate?.(input.kind) ?? true)) opts.crumbSink(input);
    } catch {
      /* swallow — DEFE-02: a crumb-sink bug must never break console */
    }
  };
  // Capture ALL originals (not just `levels`) so uninstall fully restores any methods
  // we patched — and so chain-call works even when caller narrowed levels.
  const originals = {} as Record<Level, (...args: unknown[]) => void>;
  for (const l of ALL_LEVELS) {
    originals[l] = console[l].bind(console) as (...args: unknown[]) => void;
  }

  for (const l of levels) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (console as any)[l] = (...args: unknown[]) => {
      const message = formatConsoleArgs(args);
      pushLogEntry({ level: l, message, timestamp: Date.now() });
      crumb({ kind: 'console', level: CRUMB_LEVEL[l], message });
      originals[l](...args); // chain to whatever was previously installed (Sentry coexistence)
    };
  }

  // window.onerror — uncaught synchronous errors
  const prevOnError = typeof window !== 'undefined' ? window.onerror : null;
  const onError = (
    msg: Event | string,
    src?: string,
    ln?: number,
    col?: number,
    err?: Error,
  ): boolean | void => {
    const errMessage = err?.message ?? (typeof msg === 'string' ? msg : String(msg));
    pushEntry('error', [
      `[uncaught-error] ${errMessage}`,
      { src, ln, col, stack: err?.stack },
    ]);
    crumb({
      kind: 'error',
      level: 'error',
      message: errMessage,
      ...(err?.stack ? { data: { stackDigest: err.stack } } : {}),
    });
    try {
      opts.crashSink?.(err ?? errMessage, 'onerror');
    } catch {
      /* swallow — DEFE-02: crash capture must never break the page */
    }
    if (typeof prevOnError === 'function') {
      return prevOnError.call(window, msg, src, ln, col, err);
    }
    return false;
  };
  if (typeof window !== 'undefined') window.onerror = onError;

  // unhandledrejection — uncaught Promise errors
  const onUnhandled = (ev: PromiseRejectionEvent) => {
    const reason = ev.reason instanceof Error ? ev.reason.message : String(ev.reason);
    pushEntry('error', [`[unhandled-rejection] ${reason}`, ev.reason]);
    crumb({
      kind: 'error',
      level: 'error',
      message: reason,
      ...(ev.reason instanceof Error && ev.reason.stack
        ? { data: { stackDigest: ev.reason.stack } }
        : {}),
    });
    try {
      opts.crashSink?.(ev.reason, 'unhandledrejection');
    } catch {
      /* swallow — DEFE-02 */
    }
    // Do NOT preventDefault — let other handlers (Sentry) see the event.
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('unhandledrejection', onUnhandled);
  }

  return () => {
    for (const l of ALL_LEVELS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (console as any)[l] = originals[l];
    }
    if (typeof window !== 'undefined') {
      window.onerror = prevOnError;
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
    delete slot[PATCH_MARKER];
  };
}
