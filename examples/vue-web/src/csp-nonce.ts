// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * Static nonce, matching examples/react-web/next.config.ts, so the Playwright
 * assertion is deterministic. A real deployment issues a per-request random
 * nonce; that is the host's job and not the SDK's.
 */
export const STATIC_NONCE = 'STATIC_TEST_NONCE_FOR_PLAYWRIGHT';
