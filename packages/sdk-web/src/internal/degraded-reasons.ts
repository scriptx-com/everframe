// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/** Canonical captureControl.degradedReason values surfaced by the WebPlatformAdapter. */
export const DEGRADED_REASONS = {
  ui_tree_unavailable: 'ui_tree_unavailable',
  react_version_unsupported_fiber: 'react_version_unsupported_fiber',
  screenshot_failed: 'screenshot_failed',
  csp_blocked: 'csp_blocked',
} as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[keyof typeof DEGRADED_REASONS];
