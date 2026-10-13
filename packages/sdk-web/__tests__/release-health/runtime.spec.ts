// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, expect, it, vi } from 'vitest';
import { acquireWebHealth, type WebHealthLease } from '../../src/release-health/runtime.js';
const leases:WebHealthLease[]=[];
afterEach(()=>{leases.forEach(x=>x.revoke());leases.length=0;localStorage.clear();vi.unstubAllGlobals();});
it('preserves a page session across reownership and bfcache; stale leases cannot fail or revoke it',async()=>{
 const records:any[]=[];vi.stubGlobal('fetch',async(_u:string,i:RequestInit)=>{records.push(JSON.parse(String(i.body)));return new Response('{}',{status:201});});
 const opts={endpoint:'https://example.test',sdkKey:crypto.randomUUID(),app:{version:'12.3.5-12-web',build:null,debug:false},sdkVersion:'1.2.2',platform:'web' as const,subject:{kind:'anonymous' as const}};
 const a=acquireWebHealth(opts);leases.push(a);a.release();const b=acquireWebHealth(opts);leases.push(b);
 a.revoke();a.fail('onerror');
 window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
 document.dispatchEvent(new Event('visibilitychange'));await new Promise(r=>setTimeout(r,0));
 expect(records.map(r=>r.phase)).toEqual(['start']);
 window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:false}));b.fail('unhandledrejection');
 await new Promise(r=>setTimeout(r,20));expect(records.map(r=>r.phase)).toEqual(['start','end','failure']);
 expect(new Set(records.map(r=>r.exposure.exposureId)).size).toBe(1);
});
