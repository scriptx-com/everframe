// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Full redaction impl lands in Plan 01-04. This is the type-only surface.

export type CustomRule =
  | { type: 'header'; match: RegExp | string; replacement?: string }
  | { type: 'pattern'; match: RegExp; replacement?: string }
  | { type: 'urlParam'; match: RegExp | string; replacement?: string };
