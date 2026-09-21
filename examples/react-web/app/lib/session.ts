// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// A DELIBERATELY FAKE two-user session, so the example can demonstrate account
// switching — the one behaviour the `identity` prop's `key` exists to make
// correct.
//
// !! DO NOT COPY THE TOKEN FORMAT !!  These "access tokens" are unsigned and
// trivially forgeable. A real app uses its own session or JWT verification
// here. What IS worth copying is the SHAPE: an access token in the
// Authorization header, verified server-side, with `sub` derived from the
// verification result and NEVER read from the request body or query.

export interface DemoUser {
  id: string;
  email: string;
  name: string;
}

export const DEMO_USERS: readonly DemoUser[] = [
  { id: 'elytra-demo-ada', email: 'ada@example.com', name: 'Ada Collector' },
  { id: 'elytra-demo-linnaeus', email: 'linnaeus@example.com', name: 'Carl Linnaeus' },
];

/** Fake, unsigned, short-lived. See the warning above. */
export function issueAccessToken(userId: string): string {
  const expiresAt = Date.now() + 60_000;
  return `${userId}.${expiresAt}`;
}

/** The server half. Returns null for anything expired, malformed or unknown. */
export function verifyAccessToken(authorization: string | null): DemoUser | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  const [userId, expiresAt] = authorization.slice('Bearer '.length).split('.');
  if (!userId || !expiresAt) return null;
  if (Number(expiresAt) < Date.now()) return null;
  return DEMO_USERS.find((u) => u.id === userId) ?? null;
}
