// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { resolveDebugBuild } from '../src/debug-build.js';

describe('resolveDebugBuild', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', 'app.localhost', 'shop.test', '127.0.0.5'])('treats %s as a debug build', (hostname) => {
    expect(resolveDebugBuild(undefined, { hostname })).toBe(true);
  });
  it.each(['example.com', 'localhost.example.com', 'test.example.com', '10.0.0.4'])('treats %s as a release build', (hostname) => {
    expect(resolveDebugBuild(undefined, { hostname })).toBe(false);
  });
  it('lets debugBuild win either way', () => {
    expect(resolveDebugBuild(false, { hostname: 'localhost' })).toBe(false);
    expect(resolveDebugBuild(true, { hostname: 'example.com' })).toBe(true);
  });
  it('is a release build without a location', () => {
    expect(resolveDebugBuild(undefined, null)).toBe(false);
  });
});
