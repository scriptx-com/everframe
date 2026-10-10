// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `apiKey` was the provider config's name for the SDK key until 1.2. A 1.1
// config still passes it, so the provider accepts it as a deprecated alias.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useContext } from 'react';
import { __resetSdkKeyWarning } from '@everframe/sdk-core';
import { EverframeContext, EverframeProvider, type InternalContext } from '../src/provider.js';
import type { WebEverframeConfig } from '../src/index.js';

let seen: InternalContext | null;
let warn: ReturnType<typeof vi.spyOn>;

function Probe() {
  seen = useContext(EverframeContext);
  return null;
}

function mount(config: WebEverframeConfig) {
  return render(
    <EverframeProvider config={config}>
      <Probe />
    </EverframeProvider>,
  );
}

beforeEach(() => {
  seen = null;
  __resetSdkKeyWarning();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
});

const deprecationWarnings = () =>
  warn.mock.calls.filter(([message]: unknown[]) => String(message).includes('`apiKey`'));

describe('EverframeProvider SDK key name', () => {
  it('accepts the deprecated apiKey and resolves it to sdkKey', () => {
    mount({ apiKey: 'pk_alias' }).unmount();
    expect(seen?.config.sdkKey).toBe('pk_alias');
    expect(seen && 'apiKey' in seen.config).toBe(false);
    expect(deprecationWarnings()).toHaveLength(1);
  });

  it('uses sdkKey when both names are set', () => {
    mount({ sdkKey: 'pk_new', apiKey: 'pk_old' }).unmount();
    expect(seen?.config.sdkKey).toBe('pk_new');
    expect(deprecationWarnings()).toHaveLength(1);
  });

  it('passes a config that names only sdkKey through without a warning', () => {
    mount({ sdkKey: 'pk_new' }).unmount();
    expect(seen?.config.sdkKey).toBe('pk_new');
    expect(deprecationWarnings()).toHaveLength(0);
  });

  it('leaves a config with neither name keyless, as before, without a warning', () => {
    mount({ appName: 'host' } as unknown as WebEverframeConfig).unmount();
    expect(seen?.config.sdkKey).toBeUndefined();
    expect(deprecationWarnings()).toHaveLength(0);
  });
});
