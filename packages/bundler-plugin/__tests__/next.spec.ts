// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it, vi } from 'vitest';
import { withEverframe } from '../src/next.js';

const APP = '00000000-0000-4000-8000-000000000000';

describe('withEverframe (next)', () => {
  it('adds the plugin to client production builds only and keeps the user webpack hook', () => {
    const user = vi.fn((config: { plugins: unknown[] }) => config);
    const next = withEverframe({ reactStrictMode: true, webpack: user }, { appId: APP });
    const client = next.webpack!({ plugins: [] }, { isServer: false, dev: false });
    const server = next.webpack!({ plugins: [] }, { isServer: true, dev: false });
    const dev = next.webpack!({ plugins: [] }, { isServer: false, dev: true });
    expect(user).toHaveBeenCalledTimes(3);
    expect(client.plugins).toHaveLength(1);
    expect(server.plugins).toHaveLength(0);
    expect(dev.plugins).toHaveLength(0);
    expect(next.reactStrictMode).toBe(true);
  });
});
