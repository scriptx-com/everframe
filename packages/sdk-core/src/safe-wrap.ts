// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// HOF wrapper for defensive entry-point wrapping (DEFE-02).
// Reference: research/PITFALLS.md SDK-crash safety pitfall.

type SafeWrapped<T extends (...args: any[]) => any> =
  ReturnType<T> extends Promise<infer R>
    ? (...args: Parameters<T>) => Promise<R | undefined>
    : (...args: Parameters<T>) => ReturnType<T> | undefined;

export function safeWrap<T extends (...args: any[]) => any>(
  fn: T,
  context: {
    name: string;
    onError?: (err: unknown) => void;
    /**
     * What to LOG in place of the raw error, for wrapped callbacks whose
     * thrown value can carry a secret (adversarial review of PR #218 round 6,
     * finding 2 — a host `identity()` callback throwing
     * `Error('refresh failed for Bearer ' + jwt)` put the whole live
     * credential into `console.error`, where a console-capture integration
     * exports it).
     *
     * Opt-in and logging-only: `onError` still receives the untouched error,
     * and every caller that does not pass this keeps full-fidelity
     * diagnostics. See `vitals/collector.ts`'s `identityErrorLabel` for the
     * name-only projection the identity call sites use, and
     * `types/replay/config-provider.ts` for the same precedent applied to a
     * URL-bearing fetch failure.
     */
    projectError?: (err: unknown) => unknown;
  }
): SafeWrapped<T> {
  const logged = (err: unknown): unknown => (context.projectError ? context.projectError(err) : err);
  const wrapped = function (this: unknown, ...args: Parameters<T>) {
    try {
      const result = fn.apply(this, args);
      if (result instanceof Promise) {
        return result.catch((err) => {
          context.onError?.(err);
          // eslint-disable-next-line no-console
          console.error(`[everframe] ${context.name} threw:`, logged(err));
          return undefined;
        });
      }
      return result;
    } catch (err) {
      context.onError?.(err);
      // eslint-disable-next-line no-console
      console.error(`[everframe] ${context.name} threw:`, logged(err));
      return undefined;
    }
  } as SafeWrapped<T>;

  Object.defineProperty(wrapped, 'name', { value: fn.name || context.name, configurable: true });
  return wrapped;
}
