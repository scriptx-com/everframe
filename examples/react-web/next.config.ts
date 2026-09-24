// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { NextConfig } from 'next';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Resolved through the package's own subpath export rather than by walking the
// filesystem. The old form passed an ABSOLUTE path to `experimental.swcPlugins`,
// which Turbopack treats as a module specifier — it tried to resolve
// `./Users/…/swc_plugin_displayname.wasm` and failed the build.
//
// That went unnoticed because the artifact never existed: `existsSync` was
// false, `swcPlugins` stayed empty, and the example built with the plugin
// silently disabled. The moment CI started actually building the wasm, the
// broken path surfaced. `require.resolve` uses Node's resolver, so the
// workspace link and the `./swc_plugin_displayname.wasm` export do the work,
// and there is no path to get wrong.
const SWC_PLUGIN_SPECIFIER = '@everframe/swc-plugin-displayname/swc_plugin_displayname.wasm';
// Presence is probed with the resolver; the SPECIFIER is what gets handed to
// Turbopack. Passing a resolved absolute path instead made Turbopack treat it as
// a module specifier and try `./Users/…`, failing the build.
const swcPluginWasm = (() => {
  try {
    return require.resolve(SWC_PLUGIN_SPECIFIER);
  } catch {
    return '';
  }
})();
// Conditionally enable the SWC plugin only when the .wasm artifact exists. The plugin
// requires Rust+cargo to build; CI's Rust-enabled job builds it, local dev without
// rustup skips it (component names are still preserved by SWC's default unminified dev
// output, so the framework-noise filter is what makes the UI tree readable). For
// production builds in CI, the plugin runs and bakes `Component.displayName = "Name"`
// into the minified bundle so reports stay AI-readable after terser mangles identifiers.
// OPT-IN, not automatic. Enable with EVERFRAME_SWC_PLUGIN=1.
//
// The plugin now compiles and its own 8 unit tests pass (they had never run —
// see packages/swc-plugin-displayname). Enabling it here nonetheless breaks
// this build: the emitted bundle throws `ReferenceError: Wp is not defined`
// while prerendering, i.e. the transform references a mangled binding that does
// not exist in the scope it writes into. Its case tests do not catch that
// because they transform isolated snippets rather than a minified bundle.
//
// So the artifact is verified to BUILD and to pass its unit tests, and is
// deliberately not wired into a real build until the transform is validated
// against one. Turning it on by default would trade a silent no-op for a broken
// example — see docs/known-edges.md.
const swcPluginEnabled = process.env.EVERFRAME_SWC_PLUGIN === '1';
const swcPlugins: Array<[string, Record<string, unknown>]> =
  swcPluginEnabled && swcPluginWasm && existsSync(swcPluginWasm)
    ? [[SWC_PLUGIN_SPECIFIER, {}]]
    : [];

/** Generate a per-request CSP nonce; stable enough for Playwright's spec to assert. */
function makeNonce(): string {
  // Static nonce in development for deterministic Playwright assertions.
  // Production deployments would use a per-request crypto-randomBytes nonce.
  return 'STATIC_TEST_NONCE_FOR_PLAYWRIGHT';
}

const config: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.EVERFRAME_WEB_ERROR_TEST === '1' ? '.next-error-test' : '.next',
  productionBrowserSourceMaps: process.env.EVERFRAME_SOURCE_MAPS === '1',
  transpilePackages: ['@everframe/react', '@everframe/sdk-core', '@everframe/protocol'],
  experimental: {
    swcPlugins,
  },
  async headers() {
    const nonce = makeNonce();
    // Strict CSP: tight `style-src` (Pitfall 11 — html-to-image injects <style> at capture
    // time; SDK must thread customer's nonce to those style tags or the CSP blocks them).
    // `script-src` is loose (`'unsafe-inline' 'unsafe-eval'`) because Next.js dev mode
    // injects inline bootstrap scripts that the framework — not the SDK — owns. Production
    // Next.js would tighten script-src too via middleware-driven nonces; that's outside
    // the SDK's responsibility surface and out of scope for this fixture.
    return [
      {
        source: '/strict-csp/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'nonce-${nonce}'; img-src 'self' blob: data:; connect-src 'self' http://localhost:* https://localhost:* http://127.0.0.1:*; font-src 'self' data:; object-src 'none'; base-uri 'self';`,
          },
        ],
      },
    ];
  },
};

export default config;
