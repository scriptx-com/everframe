// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { EverframeProvider } from '../src/provider.js';
import { useEverframe } from '../src/hook.js';
import type { WebEverframeConfig } from '@everframe/web';

let root: Root | undefined;
let client: ReturnType<typeof useEverframe> | undefined;
let config: WebEverframeConfig;
let strict = false;
function Controls({ killOnMount, mutateOnMount, mutateConsentOnMount }: {
  killOnMount?: boolean; mutateOnMount?: boolean; mutateConsentOnMount?: boolean;
}) {
  client = useEverframe();
  useEffect(() => {
    if (mutateOnMount) {
      config.sdkKey = 'mutated-key';
      config.releaseHealth!.loadedBuildId = 'mutated-build';
      config.releaseHealth!.userId = 'mutated-subject';
    }
    if (mutateConsentOnMount) { config.disabled = true; config.releaseHealth!.enabled = false; }
    if (killOnMount) client!.kill();
  }, []);
  return <button id="alive">Host mounted</button>;
}
export function mount(options: { sdkKey?: string; build?: string; userId?: string; strict?: boolean; killOnMount?: boolean;
  mutateOnMount?: boolean; mutateConsentOnMount?: boolean; health?: boolean; disabled?: boolean } = {}) {
  if (root) throw new Error('Unmount the previous host first');
  config = { sdkKey: options.sdkKey ?? 'pk_test_a', disabled: options.disabled === true, vitals: { enabled: false },
    ...(options.health === undefined ? {} : { releaseHealth: { enabled: options.health,
      ...(options.build === undefined ? {} : { loadedBuildId: options.build }),
      ...(options.userId === undefined ? {} : { userId: options.userId }) } }) };
  root = createRoot(document.getElementById('root')!);
  strict = options.strict === true;
  const tree = <EverframeProvider config={config}><Controls {...options}/></EverframeProvider>;
  flushSync(() => root!.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
}
export function rerender() {
  const tree = <EverframeProvider config={{ ...config, sdkKey: 'ignored-new-key',
    releaseHealth: { enabled: true, loadedBuildId: 'ignored-new-build' } }}><Controls/></EverframeProvider>;
  flushSync(() => root!.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
}
export function unmount() { flushSync(() => root?.unmount()); root = undefined; }
export function kill() { client!.kill(); }
export function identify() { client!.setUser({ id: 'must-not-enter-health', email: 'private@example.test' }); }
export async function records() {
  if (!(await indexedDB.databases()).some(db => db.name === 'everframe-release-health-v1')) return [];
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('everframe-release-health-v1'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<any[]>((resolve, reject) => {
      const read = db.transaction('records').objectStore('records').getAll();
      read.onsuccess = () => resolve(read.result.map(row => row.record)); read.onerror = () => reject(read.error);
    });
  } finally { db.close(); }
}
