// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Deprecation window (spec §1): payload.logs / payload.network stay populated,
// DERIVED from the canonical breadcrumb chain, until receivers migrate.
// Trim markers are excluded from both derived arrays — legacy consumers get
// clean entries; the chain itself is where markers surface.
import type { Breadcrumb } from '@everframe/protocol';
import type { LogEntry, NetworkEntry } from '../types/platform.js';
import { isTrimMarker } from './trim.js';

const LOG_LEVELS = new Set<LogEntry['level']>(['log', 'info', 'warn', 'error', 'debug']);

export function deriveLogsFromBreadcrumbs(crumbs: readonly Breadcrumb[]): LogEntry[] {
  return crumbs
    .filter((c) => c.kind === 'console' && !isTrimMarker(c))
    .map((c) => ({
      level:
        c.level && LOG_LEVELS.has(c.level as LogEntry['level'])
          ? (c.level as LogEntry['level'])
          : 'log',
      message: c.message,
      timestamp: c.t,
    }));
}

export function deriveNetworkFromBreadcrumbs(crumbs: readonly Breadcrumb[]): NetworkEntry[] {
  return crumbs
    .filter((c) => c.kind === 'network' && !isTrimMarker(c))
    .map((c) => {
      const d = (c.data ?? {}) as Record<string, unknown>;
      return {
        method: typeof d['method'] === 'string' ? d['method'] : 'GET',
        url: typeof d['url'] === 'string' ? d['url'] : c.message,
        ...(typeof d['status'] === 'number' ? { status: d['status'] } : {}),
        ...(typeof d['durationMs'] === 'number' ? { durationMs: d['durationMs'] } : {}),
        startedAt: c.t,
      };
    });
}
