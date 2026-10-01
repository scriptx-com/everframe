// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/** Canonical captureControl.degradedReason values surfaced by the WebPlatformAdapter. */
export const DEGRADED_REASONS = {
  ui_tree_unavailable: 'ui_tree_unavailable',
  react_version_unsupported_fiber: 'react_version_unsupported_fiber',
  screenshot_failed: 'screenshot_failed',
  screenshot_blank: 'screenshot_blank',
  /** Smart-TV path: the DOM snapshot was taken but the server render failed; the snapshot ships alone. */
  screenshot_render_failed: 'screenshot_render_failed',
  /** Smart-TV path: neither an image nor a snapshot could be produced. */
  screenshot_unavailable: 'screenshot_unavailable',
  csp_blocked: 'csp_blocked',
} as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[keyof typeof DEGRADED_REASONS];
