// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Whether this page is a debug build. Everframe never makes a release out of
// one. The bundler plugin does not say which mode built the page, so the host
// is the signal: a page served from this machine or a .test name is a
// developer's. `debugBuild` in the config wins either way.

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || LOOPBACK_V4.test(host)
    || host.endsWith('.localhost') || host.endsWith('.test');
}

export function resolveDebugBuild(configured: boolean | undefined, location?: { hostname: string } | null): boolean {
  if (configured !== undefined) return configured;
  return location ? isLocalHost(location.hostname) : false;
}
