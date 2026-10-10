// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export const DEFAULT_API_URL = "https://api.everframe.dev/api/v1";
export const MISSING_TOKEN =
  "missing_api_token: set EVERFRAME_API_TOKEN to a token with the artifacts:write scope.";
/**
 * Build integrations never fail a customer's build over symbols by default:
 * a missing token or a failed upload warns and the build continues. `--strict`
 * or EVERFRAME_SYMBOLS_STRICT=1 turns both into failures.
 */
export const symbolsStrict = (env: NodeJS.ProcessEnv, flag = false): boolean =>
  flag || env.EVERFRAME_SYMBOLS_STRICT === "1" || env.EVERFRAME_SYMBOLS_STRICT === "true";
/** A configured token never reaches build output, even inside a path. */
export const redact = (message: string, token: string | undefined): string =>
  token ? message.split(token).join("[redacted]") : message;
export const NO_TOKEN_WARNING =
  "warning: everframe: no EVERFRAME_API_TOKEN, skipping symbol upload. Crashes from this build will show raw addresses. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.";
/** The two `warning:` lines a lenient build integration prints instead of failing. */
export function uploadFailureWarnings(message: string, token: string | undefined): string[] {
  return [
    `warning: everframe: symbol upload failed: ${redact(message, token)}`,
    "warning: everframe: crashes from this build will show raw addresses until its symbols are uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.",
  ];
}
