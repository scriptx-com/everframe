// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// External review, finding 1 (Serious) — `setUser` must project to exactly
// `{ id, email, displayName }` at the SDK boundary.
//
// `UserMetadata` is a TypeScript interface with no runtime existence, so
// `tx.setUser(currentUser)` — the app handing over its OWN user object, the
// most natural call a developer writes — used to ship every other property on
// it (access tokens, addresses, roles, nested profile blobs) into durable SDK
// outboxes, event storage, admin API responses and outbound webhooks. These
// tests pin the projection at `client.setUser`, the point where the value
// ENTERS the SDK, so every downstream reader is clean by construction.
import { describe, it, expect } from 'vitest';
import { createClient, __internalClientState } from '../src/client.js';
import { projectUserMetadata } from '../src/user-projection.js';
import type { PlatformAdapter } from '../src/types/platform.js';
import type { TraceItXClient } from '../src/client.js';
import type { UserMetadata } from '../src/types/config.js';

/** Minimal adapter — `setUser` touches no adapter method at all. */
function stubAdapter(): PlatformAdapter {
  return {} as unknown as PlatformAdapter;
}

function started(): TraceItXClient {
  const client = createClient(stubAdapter());
  client.init({ apiKey: 'pk_test' });
  return client;
}

const storedUser = (client: TraceItXClient): UserMetadata | null =>
  __internalClientState.get(client)?.user ?? null;

describe('projectUserMetadata', () => {
  it('keeps exactly the three known string fields', () => {
    expect(
      projectUserMetadata({ id: 'u_1', email: 'a@b.com', displayName: 'A' }),
    ).toEqual({ id: 'u_1', email: 'a@b.com', displayName: 'A' });
  });

  it('drops extra properties, including nested objects and arrays', () => {
    expect(
      projectUserMetadata({
        id: 'u_1',
        accessToken: 'secret',
        address: { street: '1 Main St', postcode: 'SW1A 1AA' },
        roles: ['admin'],
      }),
    ).toEqual({ id: 'u_1' });
  });

  it('drops known keys that are present but not strings', () => {
    expect(projectUserMetadata({ id: 42, email: null, displayName: 'A' })).toEqual({
      displayName: 'A',
    });
  });

  it('returns null for a nullish or non-object value', () => {
    expect(projectUserMetadata(null)).toBeNull();
    expect(projectUserMetadata(undefined)).toBeNull();
    expect(projectUserMetadata('bob')).toBeNull();
    expect(projectUserMetadata(['bob'])).toBeNull();
  });

  it('copies rather than aliasing, so a later host mutation cannot change it', () => {
    const live = { id: 'u_1' };
    const projected = projectUserMetadata(live);
    live.id = 'u_2';
    expect(projected).toEqual({ id: 'u_1' });
  });

  it('reads inherited string fields (a class instance is a legitimate host user)', () => {
    class HostUser {
      constructor(public readonly id: string) {}
      get displayName(): string {
        return 'A';
      }
      get secret(): string {
        return 'do-not-ship';
      }
    }
    expect(projectUserMetadata(new HostUser('u_1'))).toEqual({ id: 'u_1', displayName: 'A' });
  });

  it('never throws when a host getter explodes — it drops only that field', () => {
    const hostile = {
      id: 'u_1',
      get email(): string {
        throw new Error('host getter exploded');
      },
      displayName: 'A',
    };
    expect(() => projectUserMetadata(hostile)).not.toThrow();
    expect(projectUserMetadata(hostile)).toEqual({ id: 'u_1', displayName: 'A' });
  });
});

describe('client.setUser projects at the SDK boundary', () => {
  it('stores only the three known fields when handed the host app user object', () => {
    const client = started();
    client.setUser({
      id: 'u_1',
      email: 'a@b.com',
      displayName: 'A',
      accessToken: 'secret-token',
      profile: { address: '1 Main St', dob: '1990-01-01' },
      loginCount: 7,
    } as unknown as UserMetadata);
    expect(storedUser(client)).toEqual({ id: 'u_1', email: 'a@b.com', displayName: 'A' });
  });

  it('does not alias the host object — a later mutation cannot change what ships', () => {
    const client = started();
    const live = { id: 'u_1' };
    client.setUser(live);
    live.id = 'u_2';
    expect(storedUser(client)).toEqual({ id: 'u_1' });
  });

  it('still clears on setUser(null)', () => {
    const client = started();
    client.setUser({ id: 'u_1' });
    client.setUser(null);
    expect(storedUser(client)).toBeNull();
  });

  it('never throws on a hostile host object', () => {
    const client = started();
    expect(() =>
      client.setUser({
        get id(): string {
          throw new Error('host getter exploded');
        },
        email: 'a@b.com',
      } as unknown as UserMetadata),
    ).not.toThrow();
    expect(storedUser(client)).toEqual({ email: 'a@b.com' });
  });
});
