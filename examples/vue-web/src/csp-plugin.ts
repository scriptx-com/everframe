// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { Plugin } from 'vite';
import { STATIC_NONCE } from './csp-nonce';

/**
 * script-src is loose because Vite's dev client injects inline bootstrap
 * scripts the FRAMEWORK owns, not the SDK. style-src is the tight one — it is
 * what the SDK has to satisfy by carrying the host's cspNonce on the reporter
 * stylesheet it injects into the shadow root at mount time.
 */
const POLICY = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,
  `style-src 'self' 'nonce-${STATIC_NONCE}'`,
  `img-src 'self' blob: data:`,
  `connect-src 'self' ws: http://localhost:* https://localhost:* http://127.0.0.1:*`,
  `font-src 'self' data:`,
  `object-src 'none'`,
  `base-uri 'self'`,
].join('; ');

export function strictCspPlugin(): Plugin {
  const middleware = (
    req: { url?: string },
    res: { setHeader(k: string, v: string): void },
    next: () => void,
  ): void => {
    // Also matches /strict-csp.css (the fixture's own stylesheet request),
    // not just /strict-csp.html — so that response carries the header too.
    // Harmless: a stylesheet response having a Content-Security-Policy
    // header has no effect (CSP only governs the document it's served with,
    // and browsers ignore the header on non-navigation responses), it's just
    // wider than strictly necessary.
    if (req.url?.startsWith('/strict-csp')) res.setHeader('Content-Security-Policy', POLICY);
    next();
  };
  return {
    name: 'traceitx:strict-csp',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
