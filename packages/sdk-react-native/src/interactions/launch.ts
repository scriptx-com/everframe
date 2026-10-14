// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { redactStringContent } from '@everframe/sdk-core';
import { bounded, captureInteractionOperation, own } from './operation.js';
export interface LaunchContext {
  trigger?: 'link' | 'notification';
  arguments?: Record<string, string | number | boolean>;
}
/** Enriches only a still-pending native foreground entry; never creates a launch. */
export function recordLaunchContext(context: LaunchContext): void {
  try {
    const capture = captureInteractionOperation();
    if (!capture) return;
    const trigger = own(context, 'trigger'),
      input = own(context, 'arguments'),
      args: Record<string, string | number | boolean> = Object.create(null);
    for (const key of capture.policy.launchArgumentKeys) {
      if (Object.keys(args).length >= 16) break;
      const value = own(input, key),
        safeKey = bounded(redactStringContent(key, {}), 128);
      if (!safeKey) continue;
      if (typeof value === 'string') {
        // URLs belong to the dedicated link sanitizer, never to launch extras.
        if (/[A-Za-z][A-Za-z0-9+.-]*:|\/\//.test(value)) continue;
        const safe = bounded(redactStringContent(value, {}), 128);
        if (safe !== undefined) args[safeKey] = safe;
      } else if (
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      )
        args[safeKey] = value;
    }
    const known = trigger === 'link' || trigger === 'notification';
    if (known || Object.keys(args).length)
      capture.emit({
        type: 'launch_context',
        ...(known ? { trigger } : {}),
        ...(Object.keys(args).length ? { arguments: args } : {}),
      });
  } catch {
    /* Optional diagnostic context. */
  }
}
