// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { DEFAULT_API_URL, redact } from '../defaults.js';
import { pushTokenToEmulators, type QuickCaptureDeps } from './commands.js';
import {
  CAPTURE_TOKEN_PATTERN,
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from './credentials.js';
import { type Runner, clearToken, defaultRunner, findAdb, listEmulators } from './devices.js';

export interface LoginDeps extends QuickCaptureDeps {
  fetch: typeof fetch;
  openBrowser: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export interface LogoutDeps extends QuickCaptureDeps {
  fetch: typeof fetch;
}

/** Opens the URL in the default browser. Never throws a shell string: args only. */
export function defaultOpenBrowser(
  platform: NodeJS.Platform = process.platform,
  run: Runner = defaultRunner,
): (url: string) => Promise<void> {
  return async (url) => {
    const [cmd, args] =
      platform === 'darwin'
        ? (['open', [url]] as const)
        : platform === 'win32'
          ? (['rundll32', ['url.dll,FileProtocolHandler', url]] as const)
          : (['xdg-open', [url]] as const);
    const result = await run(cmd, [...args]);
    if (result.code !== 0) throw new Error('browser did not open');
  };
}

const CLOSE_TAB = (line: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Everframe</title><p>${line}</p>`;

const originOf = (apiUrl: string): string | null => {
  try {
    const u = new URL(apiUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
};

type CallbackResult = { kind: 'code'; code: string } | { kind: 'denied' } | { kind: 'timeout' };

function waitForCallback(
  server: Server,
  state: string,
  timeoutMs: number,
): Promise<CallbackResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    server.on('request', (req, res) => {
      const reply = (status: number, line: string, done?: CallbackResult): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        res.end(CLOSE_TAB(line), () => {
          if (done) {
            clearTimeout(timer);
            resolve(done);
          }
        });
      };
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const given = url.searchParams.get('state');
      if (req.method !== 'GET' || url.pathname !== '/callback' || given !== state) {
        return reply(400, 'Invalid request.');
      }
      if (url.searchParams.get('error') === 'denied') {
        return reply(200, 'Login cancelled. You can close this tab.', { kind: 'denied' });
      }
      const code = url.searchParams.get('code');
      if (!code) return reply(400, 'Invalid request.');
      reply(200, 'Logged in. You can close this tab.', { kind: 'code', code });
    });
  });
}

export async function loginCommand(
  deps: LoginDeps,
  options: { url?: string; noBrowser?: boolean } = {},
): Promise<number> {
  const apiUrl = options.url || deps.env.EVERFRAME_API_URL || DEFAULT_API_URL;
  const origin = originOf(apiUrl);
  if (!origin) {
    deps.err('Invalid --url. Pass the Everframe API URL, for example https://everframe.dev/api/v1.');
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
  const close = (): void => {
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
    const pending = waitForCallback(server, state, deps.timeoutMs ?? 300_000);
    deps.out(`Opening ${loginUrl}`);
    deps.out("If the browser doesn't open, visit the URL above.");
    if (!options.noBrowser) {
      try {
        await deps.openBrowser(loginUrl);
      } catch {
        // The URL is already printed; the user can open it elsewhere.
      }
    }
    const result = await pending;
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
    const linked = (await pushTokenToEmulators(deps, exchanged.token)).filter((r) => r.ok).length;
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
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { token?: unknown; email?: unknown };
    if (typeof body.token !== 'string' || !CAPTURE_TOKEN_PATTERN.test(body.token)) return null;
    return { token: body.token, email: typeof body.email === 'string' ? body.email : '' };
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
  const origin = originOf(credentials.url) ?? originOf(DEFAULT_API_URL) ?? '';
  let revoked = false;
  try {
    const res = await deps.fetch(`${origin}/api/cli/token/revoke`, {
      method: 'POST',
      headers: { 'X-Everframe-Capture-Token': credentials.token },
    });
    revoked = res.status === 204;
  } catch {
    revoked = false;
  }
  if (!revoked) {
    deps.err(
      redact(
        "Couldn't reach Everframe to revoke the token; revoke it in Settings → Agents.",
        credentials.token,
      ),
    );
  }
  deleteCredentials(deps.home);
  const adb = findAdb(deps.env);
  if (adb) {
    for (const serial of await listEmulators(deps.run, adb)) {
      await clearToken(deps.run, adb, serial);
    }
  }
  deps.out('Logged out.');
  return 0;
}
