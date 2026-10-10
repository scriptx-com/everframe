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
/** Default time budget, in seconds, for uploads run by build integrations. */
export const INTEGRATION_BUDGET_SECONDS = 600;
/**
 * The upload deadline: EVERFRAME_UPLOAD_TIMEOUT_SECONDS when set, else the
 * integration default; manual commands without the variable have none.
 */
export function uploadDeadline(env: NodeJS.ProcessEnv, integration: boolean, now = Date.now()): number | undefined {
  const raw = env.EVERFRAME_UPLOAD_TIMEOUT_SECONDS;
  const seconds = raw && /^[1-9][0-9]{0,6}$/.test(raw) ? Number(raw) : integration ? INTEGRATION_BUDGET_SECONDS : undefined;
  return seconds === undefined ? undefined : now + seconds * 1000;
}
/** Upload dependencies carrying the deadline, if any. */
export function uploadBudget(env: NodeJS.ProcessEnv, integration: boolean): { deadline?: number } {
  const deadline = uploadDeadline(env, integration);
  return deadline === undefined ? {} : { deadline };
}
