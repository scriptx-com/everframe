// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Ingest base URL. Substituted at build time by tsup's `define` (and at test
// time by vitest's `define`), so the published bundle contains nothing but a
// string literal. The fallback below only runs if neither pipeline is wired —
// a developer accident, not a customer-visible code path.
declare const __TRACEITX_INGEST_URL__: string | undefined;
export const INGEST_URL: string =
  typeof __TRACEITX_INGEST_URL__ !== 'undefined' ? __TRACEITX_INGEST_URL__ : 'https://traceitx.com';
