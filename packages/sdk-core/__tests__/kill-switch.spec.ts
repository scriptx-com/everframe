// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClient, __internalClientState } from '../src/client.js';
import { createFakePlatformAdapter } from '../src/__test-helpers__/fake-platform-adapter.js';

describe('DEFE-03: kill switch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('after kill(), every method is a no-op', async () => {
    const adapter = createFakePlatformAdapter();
    const client = createClient(adapter);
    client.init({ apiKey: 'test' });
    client.kill();
    client.setUser({ id: 'u1' });
    client.markSensitive({});
    client.setExtra('{"k":"v"}');
    const result = await client.report.open();
    expect(result).toBeNull();
    // No adapter method should have been called after kill.
    expect(adapter.__calls.captureScreenshot).toBe(0);
    expect(adapter.__calls.showReporterUI).toBe(0);
  });

  // External review, finding 2 (Serious) — cross-SDK kill() posture parity.
  // kill() zeroizes the breadcrumb + network-body buffers and drops the
  // identity token for a GDPR / privacy-opt-out posture ("nothing captured
  // before the kill can ship afterward"); the self-declared user is
  // host-supplied PII (id / email / display name) held in the same state
  // object, and was the one field left behind. The web crash sink reads it
  // through a getter that has no `killed` check of its own
  // (`__setUserGetter`, sdk-react adapter), so a leftover value is reachable,
  // not merely resident. Android already cleared `_user` in kill(); iOS did
  // not (fixed alongside this).
  it('kill() clears the self-declared user, like the identity token and the buffers', () => {
    const client = createClient(createFakePlatformAdapter());
    client.init({ apiKey: 'test' });
    client.setUser({ id: 'u1', email: 'a@b.com', displayName: 'A' });
    expect(__internalClientState.get(client)!.user).toEqual({
      id: 'u1',
      email: 'a@b.com',
      displayName: 'A',
    });

    client.kill();

    expect(__internalClientState.get(client)!.user).toBeNull();
  });

  it('init after kill is also a no-op', () => {
    const adapter = createFakePlatformAdapter();
    const client = createClient(adapter);
    client.kill();
    client.init({ apiKey: 'test' });
    // No way to observe state externally; assert adapter calls remain 0.
    expect(adapter.__calls.registerTrigger).toBe(0);
  });
});
