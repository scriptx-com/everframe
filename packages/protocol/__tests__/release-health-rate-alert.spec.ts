// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { expect, it } from 'vitest';
import * as protocol from '../src/index.js';
const id='28c4a9ef-855f-47fc-a903-f4dc7dbe424a';
function event(metric='foreground_crash_free_sessions') {
  return {id,type:'release_health.rate_threshold_reached',schemaVersion:'1.2',createdAt:'2026-10-09T00:00:00.000Z',data:{appId:id,projectId:id,ruleId:id,metric,
    cohort:{platform:'android',nativeBuildId:'native-A',loadedBundleStatus:'known',loadedBuildId:'js-A'},
    window:{days:7,from:'2026-10-02T00:00:00.000Z',to:'2026-10-09T00:00:00.000Z'},observedAt:'2026-10-09T00:00:00.000Z',
    thresholds:{minObserved:100,minFatal:3,targetBasisPoints:9900,minOutcomeCoverageBasisPoints:9000,minIdentityCoverageBasisPoints:metric.endsWith('users')?8000:0},
    counts:{observed:100,completed:90,fatal:5,unknown:5,observedSessions:100,identifiedSessions:100,conflictingSessions:0},
    bounds:{lower:0.9,upper:0.95},coverage:{policy:'foreground-v1',population:'unknown',accounting:'current_retained_evidence'}}};
}
const parse=(value:unknown)=>{expect(protocol.ReleaseHealthRateThresholdEventSchema).toBeDefined();return protocol.ReleaseHealthRateThresholdEventSchema.safeParse(value);};
function counts(v:ReturnType<typeof event>,patch:Partial<ReturnType<typeof event>['data']['counts']>) {
  Object.assign(v.data.counts,patch);const c=v.data.counts;v.data.bounds={lower:c.completed/c.observed,upper:(c.completed+c.unknown)/c.observed};
}
it.each(['foreground_crash_free_sessions','foreground_crash_free_users'])('accepts a conservative observed %s breach',metric=>{
  const v=event(metric);expect(parse(v)).toMatchObject({success:true,data:v});
});
it('counts users separately from their sessions at the identity boundary',()=>{
  const v=event('foreground_crash_free_users');counts(v,{observedSessions:200,identifiedSessions:160});expect(parse(v).success).toBe(true);
  v.data.counts.identifiedSessions=159;expect(parse(v).success).toBe(false);
});
it('accepts exact minimum outcome coverage with consistent bounds',()=>{
  const v=event();counts(v,{completed:85,unknown:10});expect(parse(v).success).toBe(true);
  counts(v,{completed:84,unknown:11});expect(parse(v).success).toBe(false);
});
it('uses the all-observed upper bound instead of resolved-only rate',()=>{
  const v=event();counts(v,{completed:92,fatal:3,unknown:5});v.data.thresholds.targetBasisPoints=9700;
  expect(92/95).toBeLessThan(0.97);expect(parse(v).success).toBe(false);
  v.data.thresholds.targetBasisPoints=9701;expect(parse(v).success).toBe(true);
});
it('does not notify at exact target equality',()=>{
  const v=event();counts(v,{observed:300,completed:297,fatal:3,unknown:0,observedSessions:300,identifiedSessions:0});
  expect(parse(v).success).toBe(false);v.data.thresholds.targetBasisPoints=9901;expect(parse(v).success).toBe(true);
});
it('requires selected-unit volume even when all observed sessions crashed',()=>{
  const v=event();counts(v,{observed:99,completed:0,fatal:99,unknown:0,observedSessions:99,identifiedSessions:0});expect(parse(v).success).toBe(false);
});
it('requires minimum fatal volume despite a breached target',()=>{
  const v=event();counts(v,{completed:99,fatal:1,unknown:0});v.data.thresholds.targetBasisPoints=10000;expect(parse(v).success).toBe(false);
});
it.each([
  ['partition',(v:any)=>counts(v,{unknown:6})],['negative',(v:any)=>v.data.counts.fatal=-1],
  ['fractional count',(v:any)=>v.data.counts.observed=100.5],['conflict',(v:any)=>v.data.counts.conflictingSessions=1],
  ['fake lower',(v:any)=>v.data.bounds.lower=0.8],['fake upper',(v:any)=>v.data.bounds.upper=0.9],
  ['identity overflow',(v:any)=>v.data.counts.identifiedSessions=101],['session denominator',(v:any)=>v.data.counts.observedSessions=101],
  ['metric',(v:any)=>v.data.metric='population_crash_free'],['population claim',(v:any)=>v.data.coverage.population='complete'],
  ['legacy policy',(v:any)=>v.data.coverage.policy='launch-v1'],['user leak',(v:any)=>v.data.userId='person'],
  ['nested user leak',(v:any)=>v.data.counts.userIds=['person']],['report leak',(v:any)=>v.data.report={}],
  ['coverage floor',(v:any)=>v.data.thresholds.minOutcomeCoverageBasisPoints=7999],['volume floor',(v:any)=>v.data.thresholds.minObserved=19],
  ['fatal floor',(v:any)=>v.data.thresholds.minFatal=2],['zero target',(v:any)=>v.data.thresholds.targetBasisPoints=0],
  ['fractional target',(v:any)=>v.data.thresholds.targetBasisPoints=9900.5],['session identity gate',(v:any)=>v.data.thresholds.minIdentityCoverageBasisPoints=8000],
  ['unknown cohort',(v:any)=>Object.assign(v.data.cohort,{loadedBundleStatus:'unknown',loadedBuildId:null})],['web cohort',(v:any)=>v.data.cohort.platform='web'],
  ['window mismatch',(v:any)=>v.data.window.from=v.data.window.to],['observation mismatch',(v:any)=>v.data.observedAt=v.data.window.from],
])('rejects %s',(_name,change)=>{const v=event();change(v);expect(parse(v).success).toBe(false);});
it('rejects overstated user counts and an absent identity floor',()=>{
  const v=event('foreground_crash_free_users');v.data.counts.identifiedSessions=99;expect(parse(v).success).toBe(false);
  v.data.counts.identifiedSessions=100;v.data.thresholds.minIdentityCoverageBasisPoints=0;expect(parse(v).success).toBe(false);
});

it('validates reusable zero snapshots and partitions without relying on event thresholds',()=>{
  const empty={observed:0,completed:0,fatal:0,unknown:0,observedSessions:0,identifiedSessions:0,conflictingSessions:0};
  expect(protocol.ReleaseHealthRateCountsSchema.safeParse(empty).success).toBe(true);
  expect(protocol.ReleaseHealthRateCountsSchema.safeParse({...empty,unknown:1}).success).toBe(false);
  expect(protocol.ReleaseHealthRateCountsSchema.safeParse({...empty,fatal:-1,unknown:1}).success).toBe(false);
});
it('rejects invalid policy values independently of the breach formula',()=>{
  const {minIdentityCoverageBasisPoints:_,...policy}=event().data.thresholds;
  expect(protocol.ReleaseHealthRatePolicySchema.safeParse(policy).success).toBe(true);
  for(const targetBasisPoints of [0,10001,9900.5])
    expect(protocol.ReleaseHealthRatePolicySchema.safeParse({...policy,targetBasisPoints}).success).toBe(false);
});
