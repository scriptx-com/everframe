// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { WebHealthJournal } from './journal.js';
const destination = (endpoint: string, sdkKey: string) => JSON.stringify([endpoint,sdkKey]);
/** Single-flight, acknowledged delivery. Retries only run while there is queued work. */
export function createWebHealthTransport(journal: WebHealthJournal) {
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0, rerun = false;
  const revoked = new Set<string>();
  const active = new Map<string, AbortController>();
  const flush = (options: { keepalive?: boolean } = {}): Promise<void> => {
    if (timer) { clearTimeout(timer); timer=undefined; }
    if (running) { rerun=true; return running; }
    running = (async () => {
      let retryAfter = 0;
      do {
        rerun=false;
        for (const item of journal.list(new Date())) {
          const key=destination(item.endpoint,item.sdkKey);
          if(revoked.has(key)) { journal.remove(item.record.recordId); continue; }
          const controller=typeof AbortController==='undefined'?null:new AbortController();
          if(controller) active.set(key,controller);
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const init: RequestInit={method:'POST',headers:{Authorization:`Bearer ${item.sdkKey}`,'Content-Type':'application/json'},body:JSON.stringify(item.record),signal:controller?.signal ?? null};
            if(options.keepalive && typeof Request!=='undefined' && 'keepalive' in Request.prototype) init.keepalive=true;
            let request: Promise<Response>;
            try { request=fetch(item.endpoint.replace(/\/$/,'')+'/api/ingest/release-health',init); }
            catch { delete init.keepalive; request=fetch(item.endpoint.replace(/\/$/,'')+'/api/ingest/release-health',init); }
            const response=await Promise.race([request,new Promise<never>((_r,reject)=>{timeout=setTimeout(()=>{controller?.abort();reject(Error('health delivery timeout'));},10000);})]);
            if(response.ok || (response.status>=400 && response.status<500 && ![408,429].includes(response.status))) journal.remove(item.record.recordId);
            if(response.status===429) {
              const value=response.headers.get('Retry-After')??'';
              retryAfter=Math.max(retryAfter,/^\d+$/.test(value)?Number(value)*1000:Math.max(0,Date.parse(value)-Date.now())||0);
            }
          } catch { /* keep immutable records for retry; never reject into the host */ }
          finally { if(timeout)clearTimeout(timeout);active.delete(key); }
        }
      } while(rerun);
      if(journal.list(new Date()).length) {
        const delay=Math.max(retryAfter,[1000,5000,30000,300000][Math.min(attempt++,3)]!);
        timer=setTimeout(()=>{timer=undefined;void flush();},Math.min(delay,2147483647));
      } else attempt=0;
    })().finally(()=>{running=null;});
    return running;
  };
  return { flush, revoke(endpoint:string,sdkKey:string) {
    const key=destination(endpoint,sdkKey);revoked.add(key);active.get(key)?.abort();journal.revoke(endpoint,sdkKey);
    if(timer && !journal.list(new Date()).length) {clearTimeout(timer);timer=undefined;}
  } };
}
