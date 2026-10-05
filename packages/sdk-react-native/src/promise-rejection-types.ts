// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export type RejectionReason = 'none' | 'opt-in-required' | 'crash-reporting-disabled'
  | 'platform' | 'runtime' | 'promise-identity' | 'hook-shape' | 'hook-install'
  | 'hook-displaced' | 'no-mount';
