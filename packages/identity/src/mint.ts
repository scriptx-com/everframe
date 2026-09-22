// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { SignJWT } from 'jose';
import {
  CLAIM_MAX,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_SECRET_LENGTH,
  SUBJECT_MAX,
  type IdentityUser,
} from './types.js';

/**
 * Validated eagerly by both entry points so a misconfiguration fails at
 * construction — a developer holding a stack trace — rather than as silent
 * anonymity in production, which is what a server-side rejection looks like.
 */
export function assertValidSecret(secret: unknown): asserts secret is string {
  if (typeof secret !== 'string' || secret.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `@traceitx/identity: secret must be a string of at least ${MIN_SECRET_LENGTH} characters. ` +
        'Generate one in Project settings -> User recognition and read it from your environment.',
    );
  }
}

export function assertValidProjectId(projectId: unknown): asserts projectId is string {
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw new Error('@traceitx/identity: projectId must be a non-empty string.');
  }
}

export function assertValidTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(
      `@traceitx/identity: ttlSeconds must be a positive integer <= ${MAX_TTL_SECONDS}. ` +
        'TraceItX rejects longer-lived tokens as ttl_too_long.',
    );
  }
}

/** Empty/over-length optional claims are ABSENT, never an error. */
function optionalClaim(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > CLAIM_MAX) return undefined;
  return trimmed;
}

export interface NormalizedUser {
  sub: string;
  email: string | undefined;
  name: string | undefined;
}

/**
 * Throws on a bad `sub`. The HANDLER catches this and degrades to
 * `{ token: null, reason }`; `mintIdentityToken` lets it propagate. The two
 * differ on purpose — see the spec's "The package" section.
 */
export function normalizeUser(user: IdentityUser): NormalizedUser {
  const sub = typeof user?.id === 'string' ? user.id.trim() : '';
  if (sub === '' || sub.length > SUBJECT_MAX) {
    throw new SubjectError(
      `@traceitx/identity: user.id must be a non-empty string of at most ${SUBJECT_MAX} characters.`,
    );
  }
  return { sub, email: optionalClaim(user.email), name: optionalClaim(user.name) };
}

/** Distinguishable so the handler can degrade on THIS and 500 on anything else. */
export class SubjectError extends Error {
  public readonly reason = 'subject_too_long' as const;
}

export interface MintOptions {
  secret: string;
  projectId: string;
  user: IdentityUser;
  ttlSeconds?: number;
  /**
   * Test-only clock injection. Production callers omit it.
   * @internal
   */
  now?: Date;
}

export async function mintIdentityToken(opts: MintOptions): Promise<string> {
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  assertValidSecret(opts.secret);
  assertValidProjectId(opts.projectId);
  assertValidTtl(ttlSeconds);
  const { sub, email, name } = normalizeUser(opts.user);

  // ONE clock read. Deriving exp from a second read can drift a ttl of 600
  // into 601, which the verifier rejects outright as ttl_too_long.
  const iat = Math.floor((opts.now?.getTime() ?? Date.now()) / 1000);

  return await new SignJWT({
    ...(email !== undefined ? { email } : {}),
    ...(name !== undefined ? { name } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience(opts.projectId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(new TextEncoder().encode(opts.secret));
}
