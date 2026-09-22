// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * Bounded-fetch abort signal that works on engines without `AbortSignal.timeout`
 * (Chrome 103+). Smart-TV webviews are far older — webOS 6.x is Chrome 79,
 * Tizen ≤ 7 is ≤ M94 — and there the bare static call throws a synchronous
 * TypeError, which is how every /api/config refresh on those TVs died before
 * a single request reached the network (field bug 2026-08-27). Falls back to
 * `AbortController` + `setTimeout`; returns null when no abort primitive
 * exists at all (RequestInit accepts `signal: null`, an unbounded fetch).
 */
/**
 * Bound the WAIT on a promise even when the underlying work cannot be
 * aborted. Chrome < 66 (webOS 4.x, Tizen 3/4) has neither AbortSignal.timeout
 * nor AbortController — timeoutSignal returns null there, and a bare fetch
 * would hang its caller forever (codex round-2 finding 7). The work itself
 * keeps running (nothing can cancel it); what matters is that the caller
 * stops waiting and follows its fail-closed path. Same posture as
 * screenshot.ts's withDeadline.
 */
export function boundWait<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function timeoutSignal(ms: number): AbortSignal | null {
  const AS = typeof AbortSignal !== 'undefined'
    ? (AbortSignal as { timeout?: (ms: number) => AbortSignal })
    : undefined;
  if (AS && typeof AS.timeout === 'function') {
    return AS.timeout(ms);
  }
  if (typeof AbortController === 'undefined') {
    return null;
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
