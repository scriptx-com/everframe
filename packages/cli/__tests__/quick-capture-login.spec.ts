// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  credentialsPath,
  readCredentials,
  writeCredentials,
} from '../src/quick-capture/credentials.js';
import { loginCommand, logoutCommand } from '../src/quick-capture/login.js';

const TOKEN = `evf_cap_${'Q'.repeat(32)}`;
const CODE = `evf_clc_${'a'.repeat(32)}`;

function setup(opts: { adb?: boolean; env?: NodeJS.ProcessEnv; emulators?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'evf-login-home-'));
  const sdk = mkdtempSync(join(tmpdir(), 'evf-login-sdk-'));
  mkdirSync(join(sdk, 'platform-tools'));
  writeFileSync(join(sdk, 'platform-tools', 'adb'), '');
  chmodSync(join(sdk, 'platform-tools', 'adb'), 0o755);
  const base = opts.adb === false ? { PATH: '/nonexistent' } : { ANDROID_HOME: sdk, PATH: '' };
  const env = { ...base, ...opts.env };
  const calls: [string, string[]][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    if (args[0] === 'devices') {
      return { stdout: opts.emulators ?? '', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  const out: string[] = [];
  const err: string[] = [];
  const fetchCalls: { url: string; init: RequestInit }[] = [];
  let exchange: () => Response = () =>
    new Response(JSON.stringify({ token: TOKEN, email: 'dev@example.com' }), { status: 200 });
  let revoke: () => Response = () => new Response(null, { status: 204 });
  const fakeFetch = (async (url: string | URL, init: RequestInit = {}) => {
    fetchCalls.push({ url: String(url), init });
    return String(url).endsWith('/revoke') ? revoke() : exchange();
  }) as typeof fetch;
  const opened: string[] = [];
  return {
    home,
    calls,
    out,
    err,
    fetchCalls,
    opened,
    setExchange: (f: () => Response) => (exchange = f),
    setRevoke: (f: () => Response) => (revoke = f),
    deps: {
      run,
      env,
      home,
      platform: 'darwin' as const,
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      fetch: fakeFetch,
      openBrowser: async (u: string) => {
        opened.push(u);
      },
    },
  };
}

const loginUrl = (t: ReturnType<typeof setup>) => new URL(t.out[0]!.replace(/^Opening /, ''));
async function waitForUrl(t: ReturnType<typeof setup>): Promise<URL> {
  for (let i = 0; i < 200; i++) {
    if (t.out.length > 0) return loginUrl(t);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no url');
}
const cb = (u: URL, path: string) => `http://127.0.0.1:${u.searchParams.get('port')}${path}`;
const b64 = (s: string) => createHash('sha256').update(s).digest('base64url');
const all = (t: ReturnType<typeof setup>) => [...t.out, ...t.err].join('\n');

/**
 * Stands in for an origin that answers with a 307 to another host. Like
 * Node's fetch, it follows the redirect (resending headers and body) unless
 * the caller passed `redirect: 'error'`, in which case it rejects.
 */
function redirectingFetch(t: ReturnType<typeof setup>, followed: () => Response) {
  const forwarded: { url: string; init: RequestInit }[] = [];
  t.deps.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    t.fetchCalls.push({ url: String(url), init });
    if (init.redirect === 'error') {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }
    forwarded.push({ url: 'https://attacker.example/steal', init });
    return followed();
  }) as typeof fetch;
  return forwarded;
}

describe('login', () => {
  it('builds the login URL from the default origin and completes with PKCE', async () => {
    const t = setup();
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    expect(u.origin).toBe('https://everframe.dev');
    expect(u.pathname).toBe('/admin/cli/login');
    const port = Number(u.searchParams.get('port'));
    expect(port).toBeGreaterThanOrEqual(1024);
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(u.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.out[1]).toBe("If the browser doesn't open, visit the URL above.");
    const res = await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&code=${CODE}`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Logged in. You can close this tab.');
    expect(await done).toBe(0);
    expect(t.opened).toEqual([u.toString()]);
    const call = t.fetchCalls[0]!;
    expect(call.url).toBe('https://everframe.dev/api/cli/token');
    expect(call.init.method).toBe('POST');
    const body = JSON.parse(String(call.init.body));
    expect(body.code).toBe(CODE);
    expect(body.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b64(body.verifier)).toBe(u.searchParams.get('challenge'));
    expect(readCredentials(t.home)).toEqual({
      token: TOKEN,
      url: 'https://everframe.dev',
      email: 'dev@example.com',
    });
    expect(t.out).toContain('Logged in as dev@example.com.');
    expect(t.out).toContain('iOS simulators read your login automatically.');
    expect(all(t)).not.toContain(TOKEN);
    expect(all(t)).not.toContain(body.verifier);
  });

  it('derives the origin from --url and EVERFRAME_API_URL', async () => {
    const a = setup({ env: { EVERFRAME_API_URL: 'http://localhost:3000/api/v1' } });
    const pa = loginCommand(a.deps, { noBrowser: true });
    const ua = await waitForUrl(a);
    expect(ua.origin).toBe('http://localhost:3000');
    await fetch(cb(ua, `/callback?state=${ua.searchParams.get('state')}&error=denied`));
    expect(await pa).toBe(1);
    expect(a.opened).toEqual([]);

    const b = setup({ env: { EVERFRAME_API_URL: 'http://localhost:3000/api/v1' } });
    const pb = loginCommand(b.deps, { url: 'https://staging.example.com/api/v1' });
    const ub = await waitForUrl(b);
    expect(ub.origin).toBe('https://staging.example.com');
    await fetch(cb(ub, `/callback?state=${ub.searchParams.get('state')}&code=${CODE}`));
    expect(await pb).toBe(0);
    expect(b.fetchCalls[0]!.url).toBe('https://staging.example.com/api/cli/token');
    expect(readCredentials(b.home)?.url).toBe('https://staging.example.com');
  });

  it('ignores forged callbacks and keeps waiting', async () => {
    const t = setup();
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    const state = u.searchParams.get('state');
    for (const path of [
      `/callback?state=wrong&code=${CODE}`,
      `/callback?state=${state}`,
      `/callback?code=${CODE}`,
      `/other?state=${state}&code=${CODE}`,
      `/callback?state=wrong&error=denied`,
    ]) {
      const r = await fetch(cb(u, path));
      expect(r.status, path).toBe(400);
    }
    expect(t.fetchCalls).toHaveLength(0);
    const ok = await fetch(cb(u, `/callback?state=${state}&code=${CODE}`));
    expect(ok.status).toBe(200);
    expect(await done).toBe(0);
    expect(t.fetchCalls).toHaveLength(1);
  });

  it('answers non-GET callbacks with 400 and ignores callbacks after success', async () => {
    const t = setup();
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    const state = u.searchParams.get('state');
    const post = await fetch(cb(u, `/callback?state=${state}&code=${CODE}`), { method: 'POST' });
    expect(post.status).toBe(400);
    expect(t.fetchCalls).toHaveLength(0);
    await fetch(cb(u, `/callback?state=${state}&code=${CODE}`));
    expect(await done).toBe(0);
    await expect(fetch(cb(u, `/callback?state=${state}&code=${CODE}`))).rejects.toThrow();
    expect(t.fetchCalls).toHaveLength(1);
  });

  it('does not wait for a hung browser opener', async () => {
    const t = setup();
    t.deps.openBrowser = () => new Promise<void>(() => {});
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&code=${CODE}`));
    expect(await done).toBe(0);
  });

  it('names the source of an invalid API URL', async () => {
    const a = setup();
    expect(await loginCommand(a.deps, { url: 'nope' })).toBe(1);
    expect(a.err[0]).toContain('--url');
    const b = setup({ env: { EVERFRAME_API_URL: 'nope' } });
    expect(await loginCommand(b.deps, {})).toBe(1);
    expect(b.err[0]).toContain('EVERFRAME_API_URL');
  });

  it('rejects plain http except for loopback hosts', async () => {
    const a = setup();
    expect(await loginCommand(a.deps, { url: 'http://everframe.example.com/api/v1' })).toBe(1);
    expect(a.err[0]).toContain('https is required');
    expect(a.opened).toEqual([]);
    const b = setup({ env: { EVERFRAME_API_URL: 'http://staging.example.com' } });
    expect(await loginCommand(b.deps, {})).toBe(1);
    expect(b.err[0]).toContain('https is required');
    const c = setup();
    const done = loginCommand(c.deps, { url: 'http://localhost:3000/api/v1' });
    const u = await waitForUrl(c);
    expect(u.origin).toBe('http://localhost:3000');
    await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&code=${CODE}`));
    expect(await done).toBe(0);
  });

  it('still prints the URL and succeeds when the browser fails to open', async () => {
    const t = setup();
    t.deps.openBrowser = async () => {
      throw new Error('no display');
    };
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    expect(t.out[0]).toBe(`Opening ${u.toString()}`);
    await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&code=${CODE}`));
    expect(await done).toBe(0);
  });

  it('succeeds with the link hint when adb is missing', async () => {
    const t = setup({ adb: false });
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&code=${CODE}`));
    expect(await done).toBe(0);
    expect(readCredentials(t.home)?.token).toBe(TOKEN);
    expect(t.out).toContain(
      'No running Android emulators. Run npx @everframe/cli link after starting one.',
    );
    expect(t.out).toContain('iOS simulators read your login automatically.');
  });

  it('pushes the token to running emulators quietly', async () => {
    const t = setup({ emulators: 'List of devices attached\nemulator-5554\tdevice\n' });
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&code=${CODE}`));
    expect(await done).toBe(0);
    expect(t.calls.some(([, a]) => a.includes('put') && a.includes(TOKEN))).toBe(true);
    expect(
      t.calls.some(
        ([, a]) =>
          a.includes('put') &&
          a.includes('everframe_token_origin') &&
          a.includes('https://everframe.dev'),
      ),
    ).toBe(true);
    expect(t.out).toContain('Linked 1 Android emulator.');
    expect(all(t)).not.toContain(TOKEN);
  });

  it('exits 1 on denied', async () => {
    const t = setup();
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    const r = await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&error=denied`));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Login cancelled. You can close this tab.');
    expect(await done).toBe(1);
    expect(t.err).toEqual(['Login cancelled.']);
    expect(existsSync(credentialsPath(t.home))).toBe(false);
    expect(t.fetchCalls).toHaveLength(0);
  });

  it('exits 1 without credentials when the exchange fails', async () => {
    for (const make of [
      () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      () => new Response(JSON.stringify({ token: TOKEN, email: 'x@y.z' }), { status: 201 }),
      () => new Response(JSON.stringify({ token: TOKEN }), { status: 200 }),
      () => new Response(JSON.stringify({ token: TOKEN, email: '  ' }), { status: 200 }),
      () => {
        throw new Error(`network ${TOKEN}`);
      },
    ]) {
      const t = setup();
      t.setExchange(make);
      const done = loginCommand(t.deps, {});
      const u = await waitForUrl(t);
      await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&code=${CODE}`));
      expect(await done).toBe(1);
      expect(t.err).toEqual(['Login failed. Run the command again.']);
      expect(existsSync(credentialsPath(t.home))).toBe(false);
    }
  });

  it('refuses to follow a redirect on the code exchange', async () => {
    const t = setup();
    const forwarded = redirectingFetch(
      t,
      () =>
        new Response(JSON.stringify({ token: TOKEN, email: 'dev@example.com' }), { status: 200 }),
    );
    const done = loginCommand(t.deps, {});
    const u = await waitForUrl(t);
    await fetch(cb(u, `/callback?state=${u.searchParams.get('state')}&code=${CODE}`));
    expect(await done).toBe(1);
    expect(t.fetchCalls[0]!.init.redirect).toBe('error');
    expect(forwarded).toHaveLength(0);
    expect(t.err).toEqual(['Login failed. Run the command again.']);
    expect(existsSync(credentialsPath(t.home))).toBe(false);
    expect(all(t)).not.toContain(CODE);
  });

  it('times out', async () => {
    const t = setup();
    expect(await loginCommand({ ...t.deps, timeoutMs: 50 }, {})).toBe(1);
    expect(t.err).toEqual(['Login timed out.']);
    expect(existsSync(credentialsPath(t.home))).toBe(false);
  });
});

describe('logout', () => {
  it('reports when not logged in', async () => {
    const t = setup();
    expect(await logoutCommand(t.deps)).toBe(0);
    expect(t.out).toEqual(['Not logged in.']);
    expect(t.fetchCalls).toHaveLength(0);
  });

  it('revokes, deletes the file and clears emulators', async () => {
    const t = setup({ emulators: 'List of devices attached\nemulator-5554\tdevice\n' });
    writeCredentials({ token: TOKEN, url: 'https://everframe.dev', email: 'e' }, t.home);
    expect(await logoutCommand(t.deps)).toBe(0);
    const call = t.fetchCalls[0]!;
    expect(call.url).toBe('https://everframe.dev/api/cli/token/revoke');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['X-Everframe-Capture-Token']).toBe(TOKEN);
    expect(existsSync(credentialsPath(t.home))).toBe(false);
    expect(t.calls.some(([, a]) => a.includes('delete') && a.includes('everframe_token'))).toBe(
      true,
    );
    expect(
      t.calls.some(([, a]) => a.includes('delete') && a.includes('everframe_token_origin')),
    ).toBe(true);
    expect(t.out).toEqual(['Logged out.']);
    expect(all(t)).not.toContain(TOKEN);
  });

  it('uses the EVERFRAME_API_URL origin when the saved url is unusable', async () => {
    const t = setup({
      adb: false,
      env: { EVERFRAME_API_URL: 'https://staging.example.com/api/v1' },
    });
    writeCredentials({ token: TOKEN, url: '', email: 'e' }, t.home);
    expect(await logoutCommand(t.deps)).toBe(0);
    expect(t.fetchCalls[0]!.url).toBe('https://staging.example.com/api/cli/token/revoke');
  });

  it('never sends the token to the production default when no origin is known', async () => {
    const t = setup({ adb: false });
    writeCredentials({ token: TOKEN, url: 'garbage', email: 'e' }, t.home);
    expect(await logoutCommand(t.deps)).toBe(0);
    expect(t.fetchCalls).toHaveLength(0);
    expect(t.err).toEqual([
      "Couldn't reach Everframe to revoke the token; revoke it in Settings → Agents.",
    ]);
    expect(existsSync(credentialsPath(t.home))).toBe(false);
    expect(all(t)).not.toContain(TOKEN);
  });

  it('refuses to follow a redirect on the revoke request', async () => {
    const t = setup({ adb: false });
    writeCredentials({ token: TOKEN, url: 'https://everframe.dev', email: 'e' }, t.home);
    const forwarded = redirectingFetch(t, () => new Response(null, { status: 204 }));
    expect(await logoutCommand(t.deps)).toBe(0);
    expect(t.fetchCalls[0]!.init.redirect).toBe('error');
    expect(forwarded).toHaveLength(0);
    expect(t.err).toEqual([
      "Couldn't reach Everframe to revoke the token; revoke it in Settings → Agents.",
    ]);
    expect(existsSync(credentialsPath(t.home))).toBe(false);
    expect(all(t)).not.toContain(TOKEN);
  });

  it('still logs out when the revoke fails', async () => {
    const t = setup({ adb: false });
    writeCredentials({ token: TOKEN, url: 'https://everframe.dev', email: 'e' }, t.home);
    t.setRevoke(() => {
      throw new Error(`down ${TOKEN}`);
    });
    expect(await logoutCommand(t.deps)).toBe(0);
    expect(t.err).toEqual([
      "Couldn't reach Everframe to revoke the token; revoke it in Settings → Agents.",
    ]);
    expect(existsSync(credentialsPath(t.home))).toBe(false);
    expect(t.out).toEqual(['Logged out.']);
    expect(all(t)).not.toContain(TOKEN);
  });
});
