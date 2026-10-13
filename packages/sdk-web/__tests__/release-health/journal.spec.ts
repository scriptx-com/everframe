import { beforeEach, expect, it, vi } from 'vitest';
import { createWebHealthJournal } from '../../src/release-health/journal.js';
import { createWebHealthSession } from '../../src/release-health/session.js';
import { exposure, at } from './fixture.js';
const item = () => ({ endpoint:'https://example.test', sdkKey:'key', record:createWebHealthSession(exposure()).start() });
beforeEach(() => localStorage.clear());
it('keeps other tabs records when acknowledging one record and revokes only its destination', () => {
 const a=createWebHealthJournal(localStorage), b=createWebHealthJournal(localStorage), first=item(), second=item();
 a.put(first); b.put(second); a.remove(first.record.recordId);
 expect(b.list(at).map(x=>x.record.recordId)).toEqual([second.record.recordId]);
 b.put({...item(),sdkKey:'other'}); a.revoke(first.endpoint,first.sdkKey);
 expect(b.list(at).map(x=>x.sdkKey)).toEqual(['other']);
});
it('expires records and bounds the queue while retaining memory on storage failure', () => {
 const storage={ get length(){throw Error('blocked');}, setItem(){throw Error('quota');} } as unknown as Storage;
 const a=createWebHealthJournal(storage);
 for(let n=0;n<140;n++) a.put(item());
 expect(a.list(at)).toHaveLength(128);
 expect(a.list(new Date('2026-12-01T00:00:00.000Z'))).toEqual([]);
});
it('rejects malformed persisted records', () => {
 localStorage.setItem('everframe:release-health:bad','{"record":{}}');
 expect(createWebHealthJournal(localStorage).list(at)).toEqual([]);
});
