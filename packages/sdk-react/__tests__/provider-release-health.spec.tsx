// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { StrictMode, useContext, useEffect } from 'react';
import { cleanup,render } from '@testing-library/react';
import { afterEach,expect,it,vi } from 'vitest';
import { EverframeProvider, EverframeContext } from '../src/provider.js';
vi.mock('@everframe/web/ui',()=>({ReporterDialog:()=>null,ReporterFab:()=>null,CompanionPinCard:()=>null,CompanionBadge:()=>null,InboxDialog:()=>null,Toast:()=>null}));
afterEach(()=>{cleanup();localStorage.clear();vi.unstubAllGlobals();});
it('reports one document session across StrictMode effects and provider remounts',async()=>{
 const records:any[]=[];vi.stubGlobal('fetch',async(url:string,init?:RequestInit)=>{if(String(url).endsWith('/api/ingest/release-health'))records.push(JSON.parse(String(init?.body)));return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});});
 const config={sdkKey:'key-'+crypto.randomUUID(),appVersion:'12.3.5-12-web',debugBuild:false,reporter:{disabled:true}};
 const first=render(<StrictMode><EverframeProvider config={config}><span>host</span></EverframeProvider></StrictMode>);
 first.unmount();const second=render(<EverframeProvider config={config}><span>host</span></EverframeProvider>);
 window.onerror?.('unhandled','app.js',1,1,new Error('unhandled'));await new Promise(r=>setTimeout(r,30));
 expect(records.map(r=>r.phase)).toEqual(['start','failure']);expect(records[0].exposure.exposureId).toBe(records[1].exposure.exposureId);
 second.unmount();
});
it.each([{ crashReporting: { disabled: true } }, { disabled: true }])('erases pending health work when a remount withdraws permission %j', async veto => {
 const sdkKey = 'key-' + crypto.randomUUID();
 vi.stubGlobal('fetch', async () => { throw Error('offline'); });
 const config = { sdkKey, appVersion: '1', debugBuild: false, reporter: { disabled: true } };
 const first = render(<EverframeProvider config={config}><span>host</span></EverframeProvider>);
 await new Promise(r => setTimeout(r, 20));
 const queued = () => Object.keys(localStorage).filter(k => k.startsWith('everframe:release-health:') && localStorage.getItem(k)!.includes(sdkKey));
 expect(queued()).toHaveLength(1); first.unmount();
 render(<EverframeProvider config={{ ...config, ...veto }}><span>off</span></EverframeProvider>);
 await new Promise(r => setTimeout(r, 20)); expect(queued()).toHaveLength(0);
});

it('withdraws pending delivery when a replacement is killed in a child mount effect', async () => {
 vi.useFakeTimers();
 const sdkKey = 'key-' + crypto.randomUUID();
 let online = false;
 const delivered: string[] = [];
 vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  if (!online) throw Error('offline');
  if (String(url).endsWith('/api/ingest/release-health')) delivered.push(JSON.parse(String(init?.body)).phase);
  return new Response('{}', { status: 200 });
 });
 const config = { sdkKey, appVersion: '1', debugBuild: false, reporter: { disabled: true } };
 const first = render(<EverframeProvider config={config}><span>host</span></EverframeProvider>);
 await vi.advanceTimersByTimeAsync(0);
 first.unmount();
 function WithdrawConsent() {
  const ctx = useContext(EverframeContext)!;
  useEffect(() => { ctx.client.kill(); }, [ctx]);
  return null;
 }
 try {
  render(<EverframeProvider config={config}><WithdrawConsent /></EverframeProvider>);
  online = true;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(delivered).toEqual([]);
  expect(Object.keys(localStorage).filter(k => k.startsWith('everframe:release-health:') && localStorage.getItem(k)!.includes(sdkKey))).toEqual([]);
 } finally { vi.useRealTimers(); }
});
