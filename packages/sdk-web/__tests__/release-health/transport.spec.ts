import { afterEach, expect, it, vi } from 'vitest';
import { createWebHealthJournal } from '../../src/release-health/journal.js';
import { createWebHealthTransport } from '../../src/release-health/transport.js';
import { createWebHealthSession } from '../../src/release-health/session.js';
import { exposure, at } from './fixture.js';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('retries network failure, keeps immutable IDs, and acknowledges delivered rows', async()=>{
 vi.useFakeTimers();vi.setSystemTime(at);
 const journal=createWebHealthJournal(null), record=createWebHealthSession(exposure()).start();
 journal.put({endpoint:'https://example.test',sdkKey:'key',record});
 const received: unknown[]=[];let attempt=0;
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{received.push(JSON.parse(String(init.body))); if(attempt++===0)throw Error('offline');return new Response('{}',{status:201});});
 const transport=createWebHealthTransport(journal);await transport.flush();
 expect(journal.list(at)).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1000);
 expect(received).toEqual([record,record]);expect(journal.list(at)).toEqual([]);
});
it('revocation aborts in-flight work and late failures cannot resurrect it', async()=>{
 vi.useFakeTimers();vi.setSystemTime(at);
 const journal=createWebHealthJournal(null);journal.put({endpoint:'https://example.test',sdkKey:'key',record:createWebHealthSession(exposure()).start()});
 let reject!: (e:Error)=>void;let signal:AbortSignal|null|undefined;
 vi.stubGlobal('fetch',(_url:string,init:RequestInit)=>{signal=init.signal;return new Promise((_r,j)=>{reject=j;});});
 const t=createWebHealthTransport(journal);const pending=t.flush();t.revoke('https://example.test','key');
 expect(signal?.aborted).toBe(true);reject(Error('aborted'));await pending;
 expect(journal.list(at)).toEqual([]);expect(vi.getTimerCount()).toBe(0);
});
it('drops permanent rejection and retains rate-limited records until Retry-After',async()=>{
 vi.useFakeTimers();vi.setSystemTime(at);
 const j=createWebHealthJournal(null);j.put({endpoint:'https://example.test',sdkKey:'key',record:createWebHealthSession(exposure()).start()});
 let calls=0;vi.stubGlobal('fetch',async()=>++calls===1?new Response('{}',{status:429,headers:{'Retry-After':'10'}}):new Response('{}',{status:400}));
 const t=createWebHealthTransport(j);await t.flush();await vi.advanceTimersByTimeAsync(9999);expect(j.list(at)).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);expect(j.list(at)).toEqual([]);
});
it('honors Retry-After when another lifecycle flush arrives', async () => {
 vi.useFakeTimers();vi.setSystemTime(at);
 const j=createWebHealthJournal(null);j.put({endpoint:'https://example.test',sdkKey:'key',record:createWebHealthSession(exposure()).start()});
 const fetcher=vi.fn(async()=>new Response('{}',{status:429,headers:{'Retry-After':'10'}}));vi.stubGlobal('fetch',fetcher);
 const t=createWebHealthTransport(j);await t.flush();await t.flush();expect(fetcher).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(10000);expect(fetcher).toHaveBeenCalledTimes(2);
 t.revoke('https://example.test','key');
});
it('uses keepalive for exit records queued while the start is in flight', async () => {
 vi.useFakeTimers();vi.setSystemTime(at);
 const j=createWebHealthJournal(null),session=createWebHealthSession(exposure());
 j.put({endpoint:'https://example.test',sdkKey:'key',record:session.start()});
 let resolve!: (response:Response)=>void;
 const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue(new Response('{}',{status:201}));vi.stubGlobal('fetch',fetcher);
 const t=createWebHealthTransport(j), pending=t.flush();
 j.put({endpoint:'https://example.test',sdkKey:'key',record:session.complete(at)!});void t.flush({keepalive:true});
 resolve(new Response('{}',{status:201}));await pending;
 expect(fetcher.mock.calls[1]?.[1].keepalive).toBe(true);
});
