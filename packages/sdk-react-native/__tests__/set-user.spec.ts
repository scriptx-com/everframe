// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// setUser JS plumbing (spec 2026-08-12): top-level seam export is a safe
// no-op when no provider is mounted, and the runtime forwards straight to
// the TurboModule with NO validation/coercion — the native singleton
// (iOS TraceItX.shared.setUser / Android TraceItX.setUser, Tasks 8-9) owns
// storage and gating. Mirrors record-screen.test.ts's shape.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectUserMetadata } from '@traceitx/sdk-core';
import NativeTraceItX from '../src/NativeTraceItX.js';
import { setUser, __setCurrentContext } from '../src/contextSeam.js';
import { createRuntime } from '../src/runtime.js';
import { projectUserSpec } from '../src/user-projection.js';

interface MockedNative {
  setUser: ReturnType<typeof vi.fn>;
}
const nativeMock = NativeTraceItX as unknown as MockedNative;

/**
 * Mount a real runtime as the module-level current context, mirroring what
 * <TraceItXProvider> does on mount (runtime.mount() calls
 * __setCurrentContext(runtime) — see src/runtime.ts). No shared test helper
 * of this name exists elsewhere in this package; this is a local equivalent
 * scoped to this file.
 */
function mountProvider(): ReturnType<typeof createRuntime> {
  const rt = createRuntime({ apiKey: 'txx_test_key' });
  rt.mount();
  return rt;
}

describe('setUser', () => {
  afterEach(() => {
    __setCurrentContext(null);
    vi.clearAllMocks();
  });

  it('is a no-op when no provider is mounted', () => {
    expect(() => setUser({ id: 'u_1' })).not.toThrow();
    expect(nativeMock.setUser).not.toHaveBeenCalled();
  });

  it('forwards to the native module when mounted', () => {
    mountProvider();
    setUser({ id: 'u_1', email: 'a@b.com' });
    expect(nativeMock.setUser).toHaveBeenCalledWith({ id: 'u_1', email: 'a@b.com' });
  });

  it('clears by calling with no argument', () => {
    mountProvider();
    setUser();
    expect(nativeMock.setUser).toHaveBeenCalledWith(undefined);
  });
});

/**
 * External review, finding 2 (Serious). The facade used to hand the host's
 * object across the bridge verbatim. `TXUserSpec` is a TypeScript type with no
 * runtime existence, and the bridge parameter is `UnsafeObject`, so any value
 * crossed — and on Android `TraceItXModule.setUser` called
 * `ReadableMap.getString(key)` guarded only by `hasKey(key)`. `getString`
 * THROWS on a non-string value; `txGuardVoid` swallowed that exception BEFORE
 * `TraceItX.setUser()` was reached, so the call became a silent no-op and the
 * PREVIOUS account stayed installed. Every subsequent report — including
 * crashes — was then attributed to someone the host had explicitly replaced.
 *
 * The primary fix is this projection, applied before the bridge, so native
 * never receives a bad type. The invariant these cases pin: a `setUser` call
 * ALWAYS reaches native (never swallowed), valid string fields survive,
 * invalid ones are dropped, and a no-argument call still clears.
 */
describe('setUser projection (finding 2)', () => {
  afterEach(() => {
    __setCurrentContext(null);
    vi.clearAllMocks();
  });

  it('drops a non-string id instead of leaving the previous user installed', () => {
    mountProvider();
    // The literal case from the finding. `as unknown as ...` because this is
    // exactly what an untyped JS host (or a stale API shape) supplies — the
    // types cannot stop it at runtime, which is the whole point.
    setUser({ id: 12345 } as unknown as { id?: string });

    // Reached native — NOT swallowed — and carries no bad type. An empty
    // object replaces whoever was installed before; it never leaves them.
    expect(nativeMock.setUser).toHaveBeenCalledTimes(1);
    expect(nativeMock.setUser).toHaveBeenCalledWith({});
  });

  it('keeps the valid string fields and drops only the invalid ones', () => {
    mountProvider();
    setUser({ id: 'a', email: {} } as unknown as { id?: string });
    expect(nativeMock.setUser).toHaveBeenCalledWith({ id: 'a' });
  });

  it('drops extra host properties — only id/email/displayName cross', () => {
    mountProvider();
    setUser({
      id: 'a',
      email: 'a@b.com',
      displayName: 'A',
      accessToken: 'secret',
      address: { street: 'x' },
    } as unknown as { id?: string });
    expect(nativeMock.setUser).toHaveBeenCalledWith({
      id: 'a',
      email: 'a@b.com',
      displayName: 'A',
    });
  });

  it('never throws on a host getter that explodes, and keeps the other fields', () => {
    mountProvider();
    const hostile = {
      id: 'a',
      get email(): string {
        throw new Error('host getter exploded');
      },
      displayName: 'A',
    };
    expect(() => setUser(hostile as unknown as { id?: string })).not.toThrow();
    expect(nativeMock.setUser).toHaveBeenCalledWith({ id: 'a', displayName: 'A' });
  });

  it('treats a non-object argument as a clear, never as a no-op', () => {
    mountProvider();
    setUser(12345 as unknown as { id?: string });
    expect(nativeMock.setUser).toHaveBeenCalledWith(undefined);
  });
});

/**
 * The projection is a mirror of web's `projectUserMetadata` (sdk-core) and must
 * stay one: a host moving between the two SDKs must not discover that `setUser`
 * means something different on each. Asserted against the real web function
 * rather than a restatement of its rules, so a change on either side surfaces
 * here. The one intended divergence is the empty value — web returns `null`,
 * RN returns `undefined`, because the TurboModule bridge forbids `T | null` and
 * "no argument" is how RN expresses a clear.
 */
describe('projectUserSpec parity with web projectUserMetadata', () => {
  const cases: unknown[] = [
    { id: 'a', email: 'a@b.com', displayName: 'A' },
    { id: 12345 },
    { id: 'a', email: {} },
    { id: 'a', accessToken: 'secret' },
    {},
    [],
    'a string',
    12345,
    null,
    undefined,
  ];

  it.each(cases.map((c) => [JSON.stringify(c) ?? 'undefined', c] as const))(
    'matches web for %s',
    (_label, value) => {
      expect(projectUserSpec(value)).toEqual(projectUserMetadata(value) ?? undefined);
    }
  );
});
