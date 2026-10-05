// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as webEntry from '../src/index.web.js';
import * as nativeEntry from '../src/index.js';
import * as reactSdk from '@everframe/react';

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

describe('React Native browser entry', () => {
  it('reports Hermes observation as unsupported without altering browser exports', () => {
    expect(webEntry.getPromiseRejectionStatus()).toMatchObject({ status: 'unsupported', reason: 'platform', counters: {pending: 0} });
    expect(typeof nativeEntry.getPromiseRejectionStatus).toBe('function');
  });
  it('routes browser resolution to a dedicated web bundle and keeps native as the default', () => {
    expect(manifest.exports['.'].browser).toEqual({
      types: './dist/index.web.d.ts',
      default: './dist/index.web.js',
    });
    expect(manifest.exports['.'].default).toBe('./dist/index.js');
    expect(manifest.dependencies['@everframe/react']).toBe('workspace:^');
  });

  it('reuses the React SDK provider, reporter, and capture API', () => {
    for (const name of Object.keys(reactSdk) as Array<keyof typeof reactSdk>) {
      expect(webEntry[name]).toBe(reactSdk[name]);
    }
    expect(webEntry.EverframeProvider).toBe(reactSdk.EverframeProvider);
    expect(webEntry.useEverframe).toBe(reactSdk.useEverframe);
    expect(webEntry.open).toBe(reactSdk.open);
    expect(webEntry.captureException).toBe(reactSdk.captureException);
    expect(webEntry.Sensitive).toBe(reactSdk.Sensitive);
    expect(webEntry.EverframeSensitive).toBe(reactSdk.Sensitive);
    expect(webEntry.useEverframeSensitiveRef).toBe(reactSdk.useEverframeSensitiveRef);
  });

  it('keeps the sensitive wrapper import name on native and web', () => {
    expect(nativeEntry.Sensitive).toBe(nativeEntry.EverframeSensitive);
    expect(webEntry.EverframeSensitive).toBe(webEntry.Sensitive);
  });
});
