// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { WebReleaseHealthExposureSchema, type ReleaseHealthApp, type ReleaseHealthSubject, type WebRuntimePlatform, type WebReleaseHealthRecord } from '@everframe/protocol';
import { globalScope } from '../internal/global-scope.js';
import { generateReportId } from '../transport/draft-to-envelope.js';
import { createWebHealthSession } from './session.js';
import { createWebHealthJournal, type WebHealthJournal } from './journal.js';
import { createWebHealthTransport } from './transport.js';
export interface WebHealthOptions { sdkKey:string; endpoint:string; app:ReleaseHealthApp; sdkVersion:string; platform:WebRuntimePlatform; subject:ReleaseHealthSubject }
export interface WebHealthLease { fail(mechanism:'onerror'|'unhandledrejection',reportId?:string):void; release():void; revoke():void }
interface Entry { journal:ReturnType<typeof createWebHealthJournal>; transport:ReturnType<typeof createWebHealthTransport>; fingerprint:string; owner:object|null; revoked:boolean; fail:WebHealthLease['fail']; dispose():void; revoke():void }
const NOOP:WebHealthLease={fail(){},release(){},revoke(){}};
export function acquireWebHealth(options:WebHealthOptions):WebHealthLease {
  if(typeof window==='undefined' || typeof document==='undefined' || options.app.debug) return NOOP;
  const exposure=WebReleaseHealthExposureSchema.safeParse({exposureId:generateReportId(),pageLaunchId:generateReportId(),startedAt:new Date().toISOString(),
    platform:options.platform,sdkVersion:options.sdkVersion,app:options.app,subject:options.subject,sessionPolicy:'page-v1'});
  if(!exposure.success)return NOOP;
  const scope=globalScope() as unknown as { __everframeWebHealth?:Map<string,Entry> };
  const entries=scope.__everframeWebHealth??(scope.__everframeWebHealth=new Map());
  const key=JSON.stringify([options.endpoint,options.sdkKey]);
  const fingerprint=JSON.stringify([options.app,options.platform]);
  let entry=entries.get(key);
  if(!entry || entry.revoked || entry.fingerprint!==fingerprint) {
    entry?.dispose();
    let storage:Storage|null=null;try{storage=window.localStorage;}catch{/*memory*/}
    // Every interval for this destination shares delivery ownership, including memory fallback.
    const journal:WebHealthJournal=entry && !entry.revoked ? entry.journal : createWebHealthJournal(storage);
    // A producer only drains the destination it has permission to use now.
    const scoped={...journal,list:(now:Date)=>journal.list(now).filter(x=>x.endpoint===options.endpoint&&x.sdkKey===options.sdkKey)};
    const transport=entry && !entry.revoked ? entry.transport : createWebHealthTransport(scoped), session=createWebHealthSession(exposure.data);
    const revocationKey='everframe:health-revoked:'+key;
    const emit=(record:WebReleaseHealthRecord|null,keepalive=false)=>{
      if(!record || current.revoked)return;
      journal.put({endpoint:options.endpoint,sdkKey:options.sdkKey,record});void transport.flush({keepalive});
    };
    const onHide=(event:PageTransitionEvent)=>{if(!event.persisted&&current.owner)emit(session.complete(new Date()),true);else void transport.flush({keepalive:true});};
    const onVisibility=()=>{void transport.flush({keepalive:document.visibilityState==='hidden'});};
    const onStorage=(event:StorageEvent)=>{if(event.key===revocationKey)current.revoke();};
    const current:Entry={journal,transport,fingerprint,owner:null,revoked:false,fail:(mechanism,reportId)=>emit(session.fail(mechanism,new Date(),reportId)),
      dispose(){current.owner=null;window.removeEventListener('pagehide',onHide);document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('storage',onStorage);},
      revoke(){current.revoked=true;transport.revoke(options.endpoint,options.sdkKey);current.dispose();},
    };
    entry=current;entries.set(key,current);
    window.addEventListener('pagehide',onHide);document.addEventListener('visibilitychange',onVisibility);window.addEventListener('storage',onStorage);
    emit(session.start());
  }
  const current=entry,owner={};current.owner=owner;
  return {fail(mechanism,reportId){if(current.owner===owner&&!current.revoked)current.fail(mechanism,reportId);},
    release(){if(current.owner===owner)current.owner=null;},
    revoke(){if(current.owner!==owner)return;current.revoke();try{window.localStorage.setItem('everframe:health-revoked:'+key,generateReportId());}catch{/*restricted storage*/}},
  };
}

/** A new committed configuration can withdraw permission before it acquires a session. */
export function revokeWebHealth(endpoint:string,sdkKey:string):void {
  if(typeof window==='undefined')return;
  const key=JSON.stringify([endpoint,sdkKey]);
  const scope=globalScope() as unknown as { __everframeWebHealth?:Map<string,Entry> };
  scope.__everframeWebHealth?.get(key)?.revoke();
  try {
    createWebHealthJournal(window.localStorage).revoke(endpoint,sdkKey);
    window.localStorage.setItem('everframe:health-revoked:'+key,generateReportId());
  } catch { /* storage can be unavailable; the shared in-memory owner was revoked above */ }
}
