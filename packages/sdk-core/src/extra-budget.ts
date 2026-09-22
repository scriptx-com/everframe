// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Structure-aware budgeting for `setExtra`.
//
// The old behaviour was `extra.slice(0, N)` at the envelope boundary. For a
// JSON string — which setExtra's own docstring told hosts to pass — that
// does not truncate the payload, it destroys it: the result has no closing
// brace and nothing parses, so a consumer gets NOTHING rather than less.
//
// THE INVARIANT IS THAT THE RESULT ALWAYS PARSES: either the serialized
// value fits the budget and is returned whole, or nothing is returned at
// all. There is no eviction here — with a 16 KiB budget (see
// `EXTRA_MAX_CHARS`), a host's `extra` payload should essentially never miss
// it, so there is nothing to gain from partial delivery, and no host-neutral
// way to decide which of the host's own fields matter most anyway. A host
// that wants to shed its own content under budget can check
// `EXTRA_MAX_CHARS` itself — it has the knowledge of what its own fields
// mean that we don't.

/** Protocol ceiling — `packages/protocol/src/envelope.ts`. */
export const EXTRA_MAX_CHARS = 16384;

/** JSON.stringify that yields null rather than throwing on a cycle or a BigInt. */
function safeStringify(value: unknown): string | null {
  try {
    const out = JSON.stringify(value);
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Serialize `value`. Returns the JSON string when it fits
 * {@link EXTRA_MAX_CHARS}, or `null` when it does not (or cannot be
 * serialized at all — a cycle or a BigInt), so the caller omits the field
 * rather than emitting something unparseable.
 */
export function budgetExtra(value: Record<string, unknown>): string | null {
  const out = safeStringify(value);
  if (out === null || out.length > EXTRA_MAX_CHARS) return null;
  return out;
}
