// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { DEFAULT_API_URL, redact } from '../defaults.js';
import { pushTokenToEmulators, type QuickCaptureDeps } from './commands.js';
import {
  CAPTURE_TOKEN_PATTERN,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from './credentials.js';
import { clearToken, findAdb, listEmulators } from './devices.js';

export interface LoginDeps extends QuickCaptureDeps {
  fetch: typeof fetch;
  openBrowser: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export interface LogoutDeps extends QuickCaptureDeps {
  fetch: typeof fetch;
}

/** Opens the URL in the default browser, detached; never waits and never throws. */
export function defaultOpenBrowser(
  platform: NodeJS.Platform = process.platform,
): (url: string) => Promise<void> {
  return async (url) => {
    const [cmd, args] =
      platform === 'darwin'
        ? (['open', [url]] as const)
        : platform === 'win32'
          ? (['rundll32', ['url.dll,FileProtocolHandler', url]] as const)
          : (['xdg-open', [url]] as const);
    try {
      const child = spawn(cmd, [...args], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } catch {
      // The URL is printed; the user can open it themselves.
    }
  };
}

const EXCHANGE_TIMEOUT_MS = 15_000;

// fetch follows 307/308 by resending the headers and body, which would hand
// the login code, verifier or capture token to whatever origin the redirect
// names. Credential-bearing requests reject redirects instead; the rejection
// lands in the same catch as a network error.
const NO_REDIRECT = 'error' as const;

const CLOSE_TAB = (line: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Everframe</title><p>${line}</p>`;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const originOf = (apiUrl: string): string | null => {
  try {
    const u = new URL(apiUrl);
    if (u.protocol === 'https:') return u.origin;
    // Plain HTTP would carry the login code and token in the clear, so it is
    // accepted for loopback hosts only.
    if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return u.origin;
    return null;
  } catch {
    return null;
  }
};

type CallbackResult = { kind: 'code'; code: string } | { kind: 'denied' } | { kind: 'timeout' };

interface Callback {
  result: Promise<CallbackResult>;
  /** Resolves once the last reply has flushed or the connection dropped. */
  flushed: Promise<void>;
  cancel: () => void;
}

function waitForCallback(server: Server, state: string, timeoutMs: number): Callback {
  let settle!: (r: CallbackResult) => void;
  let flush!: () => void;
  const result = new Promise<CallbackResult>((resolve) => (settle = resolve));
  const flushed = new Promise<void>((resolve) => (flush = resolve));
  let settled = false;
  const timer = setTimeout(() => {
    settled = true;
    settle({ kind: 'timeout' });
  }, timeoutMs);
  timer.unref();
  server.on('request', (req, res) => {
    const reply = (status: number, line: string, done?: CallbackResult): void => {
      if (settled) {
        res.writeHead(400, { connection: 'close' });
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      if (done) {
        settled = true;
        clearTimeout(timer);
        res.once('close', flush);
        setTimeout(flush, 1000).unref();
        settle(done);
      }
      res.end(CLOSE_TAB(line));
    };
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      // A target like `//[` throws; escaping the listener would kill the login.
      return reply(400, 'Invalid request.');
    }
    if (
      req.method !== 'GET' ||
      url.pathname !== '/callback' ||
      url.searchParams.get('state') !== state
    ) {
      return reply(400, 'Invalid request.');
    }
    if (url.searchParams.get('error') === 'denied') {
      return reply(200, 'Login cancelled. You can close this tab.', { kind: 'denied' });
    }
    const code = url.searchParams.get('code');
    if (!code) return reply(400, 'Invalid request.');
    reply(200, 'Logged in. You can close this tab.', { kind: 'code', code });
  });
  return { result, flushed, cancel: () => clearTimeout(timer) };
}

export async function loginCommand(
  deps: LoginDeps,
  options: { url?: string; noBrowser?: boolean } = {},
): Promise<number> {
  const source = options.url ? '--url' : deps.env.EVERFRAME_API_URL ? 'EVERFRAME_API_URL' : null;
  const apiUrl = options.url || deps.env.EVERFRAME_API_URL || DEFAULT_API_URL;
  const origin = originOf(apiUrl);
  if (!origin) {
    deps.err(
      `Invalid API URL${source ? ` in ${source}` : ''}. https is required (http is allowed only for localhost). Use a URL such as https://everframe.dev/api/v1.`,
    );
    return 1;
  }
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  const server = createServer();
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(0, '127.0.0.1', () => resolve(true));
  });
  if (!listening) {
    deps.err('Login failed. Run the command again.');
    return 1;
  }
  let callback: Callback | undefined;
  const close = (): void => {
    callback?.cancel();
    server.close();
    server.closeAllConnections();
  };
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const loginUrl = `${origin}/admin/cli/login?${new URLSearchParams({
      port: String(port),
      state,
      challenge,
    }).toString()}`;
    callback = waitForCallback(server, state, deps.timeoutMs ?? 300_000);
    deps.out(`Opening ${loginUrl}`);
    deps.out("If the browser doesn't open, visit the URL above.");
    if (!options.noBrowser) {
      // Never awaited: a slow or hung opener must not delay the callback.
      // The URL is already printed, so failures are ignored.
      try {
        void Promise.resolve(deps.openBrowser(loginUrl)).catch(() => {});
      } catch {
        // ignored
      }
    }
    const result = await callback.result;
    if (result.kind !== 'timeout') await callback.flushed;
    close();
    if (result.kind === 'timeout') {
      deps.err('Login timed out.');
      return 1;
    }
    if (result.kind === 'denied') {
      deps.err('Login cancelled.');
      return 1;
    }
    const exchanged = await exchange(deps.fetch, origin, result.code, verifier);
    if (!exchanged) {
      deps.err('Login failed. Run the command again.');
      return 1;
    }
    try {
      writeCredentials({ token: exchanged.token, url: origin, email: exchanged.email }, deps.home);
    } catch {
      deps.err('Login failed. Run the command again.');
      return 1;
    }
    deps.out(`Logged in as ${exchanged.email}.`);
    const linked = (await pushTokenToEmulators(deps, exchanged.token, origin)).filter(
      (r) => r.ok,
    ).length;
    deps.out(
      linked > 0
        ? `Linked ${linked} Android ${linked === 1 ? 'emulator' : 'emulators'}.`
        : 'No running Android emulators. Run npx @everframe/cli link after starting one.',
    );
    deps.out('iOS simulators read your login automatically.');
    return 0;
  } finally {
    close();
  }
}

async function exchange(
  doFetch: typeof fetch,
  origin: string,
  code: string,
  verifier: string,
): Promise<{ token: string; email: string } | null> {
  try {
    const res = await doFetch(`${origin}/api/cli/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier }),
      redirect: NO_REDIRECT,
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { token?: unknown; email?: unknown };
    if (typeof body.token !== 'string' || !CAPTURE_TOKEN_PATTERN.test(body.token)) return null;
    if (typeof body.email !== 'string' || body.email.trim() === '') return null;
    return { token: body.token, email: body.email };
  } catch {
    return null;
  }
}

export async function logoutCommand(deps: LogoutDeps): Promise<number> {
  const credentials = readCredentials(deps.home);
  if (!credentials) {
    deps.out('Not logged in.');
    return 0;
  }
  // Never fall back to the production default: the token must only go to the
  // origin it was issued by, or the one the user configured.
  const envUrl = deps.env.EVERFRAME_API_URL;
  const origin = originOf(credentials.url) ?? (envUrl ? originOf(envUrl) : null);
  let revoked = false;
  if (origin) {
    try {
      const res = await deps.fetch(`${origin}/api/cli/token/revoke`, {
        method: 'POST',
        headers: { 'X-Everframe-Capture-Token': credentials.token },
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
      revoked = res.status === 204;
    } catch {
      revoked = false;
    }
  }
  if (!revoked) {
    deps.err(
      redact(
        "Couldn't reach Everframe to revoke the token; revoke it in Settings → Agents.",
        credentials.token,
      ),
    );
  }
  try {
    deleteCredentials(deps.home);
  } catch {
    deps.err("Couldn't remove the saved login. Delete ~/.everframe/credentials yourself.");
    return 1;
  }
  const adb = findAdb(deps.env, process.platform, deps.home);
  if (adb) {
    for (const serial of await listEmulators(deps.run, adb)) {
      await clearToken(deps.run, adb, serial);
    }
  }
  deps.out('Logged out.');
  return 0;
}
